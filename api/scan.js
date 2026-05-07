// Vercel Edge Function — runs on Cloudflare's network, not blocked by Reddit
export const config = { runtime: "edge" };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── Query generation via Claude ─────────────────────────────────────────────

async function generateQueries(brand, description, competitors, language) {
  const prompt = `You are a Reddit marketing expert. Generate Reddit search queries to find:
1. Threads that mention the brand (brand awareness)
2. Threads where someone has a problem or need that this brand solves (opportunities)
3. Threads comparing or asking about competitors

Brand: "${brand}"
Description: ${description || "not provided"}
Competitors: ${competitors.length ? competitors.join(", ") : "none"}
Language: ${language}

Rules:
- Generate exactly 12 queries total: 4 brand + 5 intent/opportunity + 3 competitor
- Intent queries should reflect real needs/problems this brand solves — do NOT include the brand name
- Write queries as a real user would type them on Reddit (natural language)
- Write queries in the specified language (${language})
- Keep queries short: 2-5 words each

Return ONLY a JSON array of strings.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  const raw = data?.content?.[0]?.text?.trim() || "[]";
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    return JSON.parse(cleaned);
  } catch {
    return [`"${brand}"`, `"${brand}" review`, `"${brand}" ervaringen`];
  }
}

// ─── Reddit fetch (runs on Cloudflare edge — not blocked) ────────────────────

async function fetchRedditResults(query, timeRange = "month") {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=${timeRange}&limit=10&type=link`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "OpportunityScanner/1.0" },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json?.data?.children || []).map((c) => c.data);
  } catch {
    return [];
  }
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

// ─── Scoring ─────────────────────────────────────────────────────────────────

function scoreThread(post, analysis) {
  let score = analysis.relevanceScore || 0;
  const ageHours = (Date.now() / 1000 - post.created_utc) / 3600;

  if (ageHours < 72) score += 8;
  if ((post.num_comments || 0) < 5) score += 5;
  if (analysis.competitorMentioned) score += 7;
  if (analysis.antiPromoContext) score -= 25;
  if (ageHours > 720) score -= 10;
  if (analysis.fullyAnswered) score -= 15;
  if (analysis.suggestedAction === "ignore") score -= 30;

  return Math.min(100, Math.max(0, score));
}

// ─── LLM analysis ────────────────────────────────────────────────────────────

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

A thread is an "opportunity" if someone has a need, problem, or question this brand solves — even without mentioning the brand.

Return a JSON array, one object per thread:
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
  "summary": <one sentence in ${language}>,
  "whyRelevant": <one sentence explaining the opportunity in ${language}>,
  "suggestedAction": <"reply"|"monitor"|"ignore">,
  "suggestedReply": <helpful natural Reddit reply in ${language}, or null>
}

suggestedReply: sound like a genuine Redditor, max 3 sentences, mention brand only if it genuinely fits. null if shouldReply is "no".

Threads:
${threadList}

Return ONLY the JSON array.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      system: "You are a Reddit community analyst. Return only valid JSON arrays.",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  const raw = data?.content?.[0]?.text?.trim() || "[]";
  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    return JSON.parse(cleaned);
  } catch {
    return [];
  }
}

// ─── Edge handler ─────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { brand, language = "en", description = "", competitors = "", timeRange = "month" } =
    await req.json();

  if (!brand) {
    return new Response(JSON.stringify({ error: "Brand name is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const competitorList = competitors.split(",").map((c) => c.trim()).filter(Boolean);

  try {
    // 1. Generate queries
    const queries = await generateQueries(brand, description, competitorList, language);

    // 2. Fetch Reddit (from Cloudflare edge — not blocked)
    const fetchResults = await Promise.allSettled(
      queries.slice(0, 10).map((q) => fetchRedditResults(q, timeRange))
    );
    const allPosts = fetchResults.flatMap((r) =>
      r.status === "fulfilled" ? r.value : []
    );

    // 3. Deduplicate
    const uniquePosts = deduplicatePosts(allPosts);

    if (uniquePosts.length === 0) {
      return new Response(
        JSON.stringify({
          results: [],
          subreddits: [],
          queriesRun: queries.length,
          queries,
          warning: "Geen threads gevonden voor deze zoekopdrachten. Probeer een bredere beschrijving.",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. Analyze with Claude
    const postsToAnalyze = uniquePosts.slice(0, 20);
    const analyses = await analyzeThreads(postsToAnalyze, brand, description, competitorList, language);

    // 5. Build + filter results
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
      .filter((r) => r.suggestedAction !== "ignore" || r.relevanceScore >= 40)
      .sort((a, b) => b.score - a.score);

    if (results.length === 0) {
      return new Response(
        JSON.stringify({
          results: [],
          subreddits: [],
          queriesRun: queries.length,
          queries,
          warning: "Geen relevante threads gevonden. Reddit heeft weinig recente discussies die aansluiten bij wat je aanbiedt.",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // 6. Subreddits
    const subreddits = [
      ...new Map(
        results.map((r) => [
          r.subreddit,
          { name: r.subreddit, url: r.subredditUrl, threadCount: results.filter((x) => x.subreddit === r.subreddit).length },
        ])
      ).values(),
    ].sort((a, b) => b.threadCount - a.threadCount);

    return new Response(
      JSON.stringify({ results, subreddits, queriesRun: queries.length, queries }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
