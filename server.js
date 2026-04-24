require("dotenv").config({ override: true });
const express = require("express");
const cors = require("cors");
const { Anthropic } = require("@anthropic-ai/sdk");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Claude-powered query generation ─────────────────────────────────────────
// Instead of dumb keyword extraction, we ask Claude to generate smart queries:
// brand mention queries + high-intent opportunity queries in the right language.

async function generateQueries(brand, description, competitors, language) {
  const prompt = `You are a Reddit marketing expert. Generate Reddit search queries to find:
1. Threads that mention the brand (brand awareness)
2. Threads where someone has a problem or need that this brand solves (opportunities to engage)
3. Threads comparing or asking about competitors

Brand: "${brand}"
Description: ${description || "not provided"}
Competitors: ${competitors.length ? competitors.join(", ") : "none"}
Language: ${language}

Rules:
- Generate exactly 12 queries total
- Mix brand queries (4) + intent/opportunity queries (5) + competitor queries (3)
- Intent queries should reflect real problems/needs that ${brand} solves — NOT include the brand name
- Write queries as a real user would type them on Reddit (natural language, no quotes needed)
- Write queries in the specified language (${language})
- Keep queries short: 2-5 words each
- For intent queries: think about what someone would search when they NEED what this brand offers

Return ONLY a JSON array of strings, e.g.: ["query one", "query two", ...]`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = message.content[0].text.trim();
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    return JSON.parse(cleaned);
  } catch {
    console.error("Failed to parse query list, using fallbacks");
    // Fallback hardcoded queries
    return [
      `"${brand}"`,
      `"${brand}" review`,
      `"${brand}" ervaringen`,
      ...competitors.map((c) => `${c} alternatief`),
    ];
  }
}

// ─── Reddit fetch — direct API (works locally + cloud with OAuth) ─────────────

async function fetchRedditDirect(query, timeRange = "month") {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=${timeRange}&limit=10&type=link`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "OpportunityScanner/1.0",
        Accept: "application/json",
      },
    });
    if (res.status === 429) throw new Error("rate_limited");
    if (!res.ok) return null; // null = blocked (403 from cloud IP)
    const json = await res.json();
    return (json?.data?.children || []).map((c) => c.data);
  } catch (err) {
    if (err.message === "rate_limited") throw err;
    return null;
  }
}

// ─── Reddit fetch — via RSS feed (fallback for blocked cloud IPs) ─────────────
// Reddit's RSS/Atom feeds are consumed by millions of RSS readers from
// datacenter IPs and are far less aggressively blocked than the JSON API.

function parseRedditRSS(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.map((m) => {
    const entry = m[1];
    const title = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim() || "";
    const link = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1] || "";
    const updated = (entry.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1] || "";
    const content = (entry.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || "";
    const category = (entry.match(/term="([^"]+)"/) || [])[1] || "";
    const id = (entry.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || "";

    // Extract text snippet from HTML content
    const selftext = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);

    // Parse permalink from link
    const permalinkMatch = link.match(/(\/r\/[^?#]+)/);
    const permalink = permalinkMatch ? permalinkMatch[1] : "";

    // Extract post ID from id field or permalink
    const idMatch = (id + permalink).match(/comments\/([a-z0-9]+)/);
    const postId = idMatch ? idMatch[1] : Math.random().toString(36).slice(2);

    return {
      id: postId,
      title,
      permalink,
      subreddit: category,
      selftext,
      score: 0,
      num_comments: 0,
      created_utc: updated ? new Date(updated).getTime() / 1000 : Date.now() / 1000,
    };
  }).filter((p) => p.title && p.permalink);
}

async function fetchRedditViaRSS(query, timeRange = "month") {
  const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new&t=${timeRange}&limit=10&type=link`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "OpportunityScanner/1.0 RSS Reader",
        Accept: "application/rss+xml, application/atom+xml, text/xml",
      },
    });
    if (!res.ok) return null;
    const xml = await res.text();
    if (!xml.includes("<entry>")) return null;
    return parseRedditRSS(xml);
  } catch {
    return null;
  }
}

// ─── Reddit fetch — via Serper.dev (Google Search, optional) ─────────────────

async function fetchRedditViaSerper(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return [];

  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: `site:reddit.com ${query}`, num: 8, gl: "us" }),
  });

  if (!res.ok) return [];
  const data = await res.json();

  const permalinks = (data.organic || [])
    .map((r) => r.link)
    .filter((u) => u && u.includes("/comments/"))
    .map((u) => u.split("?")[0].replace(/\/$/, ""));

  // Fetch each post's JSON individually
  const posts = await Promise.all(
    permalinks.map(async (url) => {
      try {
        const r = await fetch(`${url}.json?limit=1`, {
          headers: { "User-Agent": "OpportunityScanner/1.0" },
        });
        if (!r.ok) return null;
        const json = await r.json();
        return json?.[0]?.data?.children?.[0]?.data || null;
      } catch {
        return null;
      }
    })
  );

  return posts.filter(Boolean);
}

// ─── Unified fetch: JSON → RSS → Serper ──────────────────────────────────────

let redditMode = "direct"; // "direct" | "rss" | "serper"

async function fetchRedditResults(query, timeRange = "month") {
  // Try direct JSON API
  if (redditMode === "direct") {
    const direct = await fetchRedditDirect(query, timeRange);
    if (direct !== null) return direct;
    console.log("Reddit JSON API blocked — trying RSS feed");
    redditMode = "rss";
  }

  // Try RSS feed
  if (redditMode === "rss") {
    const rss = await fetchRedditViaRSS(query, timeRange);
    if (rss !== null) return rss;
    console.log("Reddit RSS also blocked — trying Serper");
    redditMode = "serper";
  }

  // Last resort: Serper (if key available)
  return fetchRedditViaSerper(query);
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function deduplicatePosts(posts) {
  const seen = new Set();
  return posts.filter((p) => {
    if (!p?.id || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

// ─── Opportunity scoring ─────────────────────────────────────────────────────
// Claude's relevanceScore is the foundation — it already judges topical fit.
// We only apply small bonuses/penalties for timing and engagement signals.

function scoreThread(post, analysis) {
  // Start from Claude's relevance judgment (0-100)
  let score = analysis.relevanceScore || 0;

  const ageHours = (Date.now() / 1000 - post.created_utc) / 3600;

  // Small bonuses for engagement opportunity signals
  if (ageHours < 72) score += 8;                      // still fresh
  if ((post.num_comments || 0) < 5) score += 5;       // low competition
  if (analysis.competitorMentioned) score += 7;        // comparing options

  // Penalties
  if (analysis.antiPromoContext) score -= 25;
  if (ageHours > 720) score -= 10;                     // >30 days old
  if (analysis.fullyAnswered) score -= 15;             // already handled
  if (analysis.suggestedAction === "ignore") score -= 30; // Claude says skip it

  return Math.min(100, Math.max(0, score));
}

// ─── LLM thread analysis ──────────────────────────────────────────────────────

async function analyzeThreads(threads, brand, description, competitors, language) {
  if (threads.length === 0) return [];

  const threadList = threads
    .map(
      (t, i) =>
        `[${i}] Title: ${t.title}\nSubreddit: r/${t.subreddit}\nBody: ${(t.selftext || "").slice(0, 400)}\nComments: ${t.num_comments} | Upvotes: ${t.score}`
    )
    .join("\n\n---\n\n");

  const prompt = `You are analyzing Reddit threads to find engagement opportunities for a brand.

Brand: "${brand}"
What it offers: ${description || "not provided"}
Competitors: ${competitors.length ? competitors.join(", ") : "none"}
Reply language: ${language}

For each thread, determine if this brand could naturally and helpfully engage.
A thread is an "opportunity" if someone has a need, problem, or question that this brand solves — even if they don't mention the brand by name.

Return a JSON array, one object per thread:
{
  "index": <number>,
  "brandMentioned": <boolean>,
  "competitorMentioned": <boolean>,
  "intentType": <"recommendation"|"problem"|"complaint"|"question"|"praise"|"other">,
  "relevanceScore": <0-100, how relevant is this for the brand to engage?>,
  "shouldReply": <"yes"|"maybe"|"no">,
  "spamRisk": <"low"|"medium"|"high">,
  "antiPromoContext": <boolean — true if the thread explicitly discourages promotion>,
  "fullyAnswered": <boolean — true if already thoroughly answered>,
  "summary": <one sentence in ${language}>,
  "whyRelevant": <one sentence explaining why this is an opportunity, in ${language}>,
  "suggestedAction": <"reply"|"monitor"|"ignore">,
  "suggestedReply": <helpful, natural Reddit reply in ${language} — or null if action is not "reply">
}

suggestedReply rules:
- Sound like a genuine Redditor helping out, not a marketer
- Lead with useful info, mention the brand naturally only if it genuinely fits
- Max 3 sentences, in ${language}
- null if shouldReply is "no"

Threads to analyze:
${threadList}

Return ONLY the JSON array.`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: "You are a Reddit community analyst. Return only valid JSON arrays.",
    messages: [{ role: "user", content: prompt }],
  });

  const raw = message.content[0].text.trim();
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    return JSON.parse(cleaned);
  } catch {
    console.error("Failed to parse LLM response:", raw.slice(0, 200));
    return [];
  }
}

// ─── /scan endpoint ──────────────────────────────────────────────────────────

app.post("/scan", async (req, res) => {
  const {
    brand,
    language = "en",
    description = "",
    competitors = "",
    timeRange = "month",
  } = req.body;

  if (!brand) return res.status(400).json({ error: "Brand name is required" });

  const competitorList = competitors
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  // Reset per-request (important for serverless)
  redditMode = "direct";

  try {
    // 1. Generate smart queries with Claude
    const queries = await generateQueries(brand, description, competitorList, language);
    console.log("Generated queries:", queries);

    // 2. Fetch Reddit results in parallel
    const fetchResults = await Promise.allSettled(
      queries.slice(0, 10).map((q) => fetchRedditResults(q, timeRange))
    );
    const allPosts = fetchResults.flatMap((r) =>
      r.status === "fulfilled" ? r.value : []
    );

    // 3. Deduplicate
    const uniquePosts = deduplicatePosts(allPosts);

    if (uniquePosts.length === 0) {
      return res.status(200).json({
        results: [],
        subreddits: [],
        queriesRun: queries.length,
        queries,
        warning: "No Reddit threads found. Reddit is blocking all requests from this server. Please try running the tool locally with 'npm start'.",
      });
    }

    // 4. Analyze with Claude (cap at 20 threads)
    const postsToAnalyze = uniquePosts.slice(0, 20);
    const analyses = await analyzeThreads(
      postsToAnalyze,
      brand,
      description,
      competitorList,
      language
    );

    // 5. Build results — filter out irrelevant threads immediately
    const results = postsToAnalyze
      .map((post, i) => {
        const analysis = analyses.find((a) => a.index === i) || {};
        const score = scoreThread(post, analysis);
        const ageHours = Math.round((Date.now() / 1000 - post.created_utc) / 3600);

        return {
          id: post.id,
          title: post.title,
          url: `https://reddit.com${post.permalink}`,
          subreddit: post.subreddit,
          subredditUrl: `https://reddit.com/r/${post.subreddit}`,
          score,
          upvotes: post.score,
          comments: post.num_comments,
          ageHours,
          type: analysis.brandMentioned
            ? "brand_mention"
            : analysis.competitorMentioned
            ? "competitor_mention"
            : "opportunity",
          summary: analysis.summary || post.title,
          intentType: analysis.intentType || "other",
          relevanceScore: analysis.relevanceScore || 0,
          shouldReply: analysis.shouldReply || "no",
          spamRisk: analysis.spamRisk || "high",
          whyRelevant: analysis.whyRelevant || "",
          suggestedAction: analysis.suggestedAction || "ignore",
          suggestedReply: analysis.suggestedReply || null,
        };
      })
      // Drop anything Claude marked as ignore with low relevance — not worth showing
      .filter((r) => r.suggestedAction !== "ignore" || r.relevanceScore >= 40)
      .sort((a, b) => b.score - a.score);

    // If everything got filtered out, say so clearly
    if (results.length === 0) {
      return res.status(200).json({
        results: [],
        subreddits: [],
        queriesRun: queries.length,
        queries,
        warning: "Geen relevante threads gevonden voor dit merk. Reddit heeft weinig recente discussies die aansluiten bij wat je aanbiedt. Probeer de beschrijving aan te passen of scan later opnieuw.",
      });
    }

    // 6. Collect unique subreddits
    const subreddits = [
      ...new Map(
        results.map((r) => [
          r.subreddit,
          {
            name: r.subreddit,
            url: r.subredditUrl,
            threadCount: results.filter((x) => x.subreddit === r.subreddit).length,
          },
        ])
      ).values(),
    ].sort((a, b) => b.threadCount - a.threadCount);

    res.json({ results, subreddits, queriesRun: queries.length, queries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Local dev: start server directly
// Vercel: export the app as a serverless function
if (require.main === module) {
  app.listen(PORT, () =>
    console.log(`Reddit Opportunity Scanner running at http://localhost:${PORT}`)
  );
}

module.exports = app;
