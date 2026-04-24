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

// ─── Query generation ────────────────────────────────────────────────────────

function buildQueries(brand, description, competitors) {
  const queries = [
    `"${brand}"`,
    `"${brand}" review`,
    `is "${brand}" legit`,
    `"${brand}" alternative`,
    `"${brand}" vs`,
  ];

  for (const c of competitors) {
    queries.push(`alternative to "${c}"`);
    queries.push(`"${c}" vs`);
    queries.push(`"${c}" alternative`);
  }

  // Intent queries derived from description keywords
  if (description) {
    const words = description
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 4)
      .slice(0, 3);
    for (const kw of words) {
      queries.push(`best ${kw} tool`);
      queries.push(`looking for ${kw}`);
      queries.push(`recommendations ${kw}`);
    }
  }

  return [...new Set(queries)]; // deduplicate
}

// ─── Reddit fetch ────────────────────────────────────────────────────────────

async function fetchRedditResults(query, language) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=10&type=link`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "RedditOpportunityScanner/1.0 (research tool)",
      "Accept-Language": language || "en",
    },
  });
  if (!res.ok) return [];
  const json = await res.json();
  return (json?.data?.children || []).map((c) => c.data);
}

// ─── Deduplication ───────────────────────────────────────────────────────────

function deduplicatePosts(posts) {
  const seen = new Set();
  return posts.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

// ─── Opportunity scoring ─────────────────────────────────────────────────────

function scoreThread(post, analysis) {
  let score = 0;
  const ageHours = (Date.now() / 1000 - post.created_utc) / 3600;

  if (analysis.intentType === "recommendation") score += 30;
  if (analysis.intentType === "problem") score += 20;
  if (analysis.competitorMentioned) score += 15;
  if (ageHours < 72) score += 10;
  if ((post.num_comments || 0) < 5) score += 10;
  if (!analysis.brandMentioned) score += 10;
  if (analysis.antiPromoContext) score -= 20;
  if (ageHours > 720) score -= 15; // >30 days
  if (analysis.fullyAnswered) score -= 10;

  return Math.min(100, Math.max(0, score));
}

// ─── LLM analysis ────────────────────────────────────────────────────────────

async function analyzeThreads(threads, brand, description, competitors) {
  if (threads.length === 0) return [];

  const threadList = threads
    .map(
      (t, i) =>
        `[${i}] Title: ${t.title}\nSubreddit: r/${t.subreddit}\nSelftext: ${(t.selftext || "").slice(0, 400)}\nComments: ${t.num_comments}\nUpvotes: ${t.score}`
    )
    .join("\n\n---\n\n");

  const prompt = `You are analyzing Reddit threads to find engagement opportunities for a brand.

Brand: "${brand}"
Brand description: ${description || "Not provided"}
Competitors: ${competitors.length ? competitors.join(", ") : "None specified"}

Analyze each thread below. Return a JSON array with one object per thread in this exact structure:
{
  "index": <number>,
  "brandMentioned": <boolean>,
  "competitorMentioned": <boolean>,
  "intentType": <"recommendation"|"problem"|"complaint"|"question"|"praise"|"other">,
  "relevanceScore": <0-100>,
  "shouldReply": <"yes"|"maybe"|"no">,
  "spamRisk": <"low"|"medium"|"high">,
  "antiPromoContext": <boolean>,
  "fullyAnswered": <boolean>,
  "summary": <one sentence>,
  "whyRelevant": <one sentence explaining opportunity>,
  "suggestedAction": <"reply"|"monitor"|"ignore">,
  "suggestedReply": <natural, helpful, non-salesy Reddit reply — or null if action is not "reply">
}

Rules for suggestedReply:
- Sound like a genuine Reddit user, not a marketer
- Lead with help or empathy, mention brand naturally if relevant
- Max 3 sentences
- null if shouldReply is "no"

Threads:
${threadList}

Return ONLY the JSON array, no other text.`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system:
      "You are a Reddit marketing analyst. Return only valid JSON arrays as instructed.",
    messages: [{ role: "user", content: prompt }],
  });

  const raw = message.content[0].text.trim();
  try {
    // Strip markdown code blocks if present
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
  } = req.body;

  if (!brand) return res.status(400).json({ error: "Brand name is required" });

  const competitorList = competitors
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  try {
    // 1. Generate queries
    const queries = buildQueries(brand, description, competitorList);

    // 2. Fetch Reddit results in parallel (max 8 queries to stay fast)
    const fetchResults = await Promise.allSettled(
      queries.slice(0, 8).map((q) => fetchRedditResults(q, language))
    );
    const allPosts = fetchResults.flatMap((r) =>
      r.status === "fulfilled" ? r.value : []
    );

    // 3. Deduplicate
    const uniquePosts = deduplicatePosts(allPosts);

    // 4. Analyze with Claude (cap at 20 threads for speed)
    const postsToAnalyze = uniquePosts.slice(0, 20);
    const analyses = await analyzeThreads(
      postsToAnalyze,
      brand,
      description,
      competitorList
    );

    // 5. Merge scores and shape output
    const results = postsToAnalyze
      .map((post, i) => {
        const analysis = analyses.find((a) => a.index === i) || {};
        const score = scoreThread(post, analysis);
        const ageHours = Math.round(
          (Date.now() / 1000 - post.created_utc) / 3600
        );

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
      .sort((a, b) => b.score - a.score);

    // 6. Collect unique subreddits
    const subreddits = [
      ...new Map(
        results.map((r) => [
          r.subreddit,
          {
            name: r.subreddit,
            url: r.subredditUrl,
            threadCount: results.filter((x) => x.subreddit === r.subreddit)
              .length,
          },
        ])
      ).values(),
    ].sort((a, b) => b.threadCount - a.threadCount);

    res.json({ results, subreddits, queriesRun: queries.slice(0, 8).length });
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
