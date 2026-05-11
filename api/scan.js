// Vercel Edge Function — runs on Cloudflare's network, not blocked by Reddit
export const config = { runtime: "edge" };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── Query generation via Claude ─────────────────────────────────────────────

async function generateQueries(brand, description, competitors, language) {
  const prompt = `You are a Reddit marketing expert. Generate Reddit search queries to find threads relevant to this brand.

Brand: "${brand}"
Description: ${description || "not provided"}
Competitors: ${competitors.length ? competitors.join(", ") : "none"}
Target language: ${language}

First, deeply understand what this brand does and what problems it solves based on the description. Then generate queries that will surface threads where people genuinely need what this brand offers.

Rules:
- Generate exactly 10 queries total: 3 brand + 4 intent/opportunity + 3 competitor
- Intent queries should target the SPECIFIC problems/needs this brand solves — derived from the description, NOT just the brand name
- Keep queries short: 2-5 words each
- Language split: write 5 queries in English AND 5 queries in ${language}
  - If ${language} is "nl": write 5 in Dutch/Flemish + 5 in English
  - If ${language} is "en": write all 10 in English
  - For other languages: 5 in that language + 5 in English
- The Dutch/target-language queries are critical — they surface threads Claude will prioritize

Return ONLY a JSON array of strings.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
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

// ─── Reddit fetch via Cloudflare Worker proxy ────────────────────────────────
// Reddit blocks Vercel IPs. We route through a Cloudflare Worker which uses
// Cloudflare's IP pool — not blocked by Reddit.

const REDDIT_PROXY = "https://reddit-proxy.jens-707.workers.dev";

async function fetchRedditResults(query, timeRange = "month") {
  const url = `${REDDIT_PROXY}/?q=${encodeURIComponent(query)}&t=${timeRange}&limit=25`;
  try {
    const res = await fetch(url);
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
  if (analysis.antiPromoContext) score -= 15;
  if (ageHours > 720) score -= 10;
  if (analysis.fullyAnswered) score -= 10;
  if (analysis.suggestedAction === "ignore") score -= 15;

  return Math.min(100, Math.max(0, score));
}

// ─── LLM analysis ────────────────────────────────────────────────────────────

async function analyzeThreads(threads, brand, description, competitors, language, indexOffset = 0) {
  if (threads.length === 0) return [];

  const threadList = threads
    .map(
      (t, i) =>
        `[${i + indexOffset}] Title: ${t.title}\nSubreddit: r/${t.subreddit}\nBody: ${(t.selftext || "").slice(0, 400)}\nComments: ${t.num_comments} | Upvotes: ${t.score}`
    )
    .join("\n\n---\n\n");

  const prompt = `You are analyzing Reddit threads to find engagement opportunities for a brand. Use the brand description as your PRIMARY lens — understand deeply what problem this brand solves, who their customers are, and what their value proposition is. Then apply that understanding to judge every thread.

Brand: "${brand}"
What it offers: ${description || "not provided"}
Competitors: ${competitors.length ? competitors.join(", ") : "none"}
Target language: ${language}

STEP 1 — LANGUAGE FILTER:
English threads are ALWAYS allowed, regardless of target language — English is Reddit's dominant language and Dutch/French/etc. users regularly post in English about topics relevant to them.

What to REJECT (relevanceScore: 0, suggestedAction: "ignore"):
- If target language is "nl": reject threads written in German, French, Spanish, Croatian, Italian, Portuguese or any non-Dutch, non-English language.
- If target language is "fr": reject threads written in German, Dutch, Spanish, Croatian, Italian, Portuguese or any non-French, non-English language.
- If target language is "en": reject threads clearly written in a non-English language.
- For any other target language: reject threads that are neither English nor the target language.

In short: keep English + keep the target language. Reject everything else.

STEP 2 — BRAND RELEVANCE (use the brand description as your primary guide):
First, internalize what this brand actually does, what problems it solves, and who its customers are — based on the description above. Then use that understanding to judge every thread.

A thread is relevant if ANY of these are true:
- It mentions the brand or its direct competitors by name
- Someone is asking for advice, recommendations, or comparisons in this brand's space
- Someone has a problem or need that this brand specifically addresses
- It discusses the sector/niche this brand operates in, from a buyer or user perspective

Be generous — give threads the benefit of the doubt if they touch on the brand's space. Only mark "ignore" if the topic is genuinely unrelated to what this brand does.

For relevanceScore:
- 0: wrong language (per Step 1) OR completely off-topic
- 20-40: same broad sector, loosely related
- 40-60: clear connection — someone is discussing a need this brand addresses
- 60-80: strong match — someone is actively asking for what this brand offers
- 80-100: perfect — brand/competitor mentioned directly, or someone is searching for exactly this

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
      model: "claude-haiku-4-5",
      max_tokens: 3000,
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

  const { brand, language = "en", description = "", competitors = "", timeRange = "year" } =
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

    // 2. Fetch Reddit (from Cloudflare edge — not blocked) — all 10 queries, 25 results each
    const fetchResults = await Promise.allSettled(
      queries.map((q) => fetchRedditResults(q, timeRange))
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

    // 4. Analyze with Claude — up to 25 posts in two parallel batches to stay within timeout
    const postsToAnalyze = uniquePosts.slice(0, 25);
    const batch1 = postsToAnalyze.slice(0, 13);
    const batch2 = postsToAnalyze.slice(13);
    const [analyses1, analyses2] = await Promise.all([
      analyzeThreads(batch1, brand, description, competitorList, language, 0),
      analyzeThreads(batch2, brand, description, competitorList, language, 13),
    ]);
    const analyses = [...analyses1, ...analyses2];

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
      .filter((r) => r.relevanceScore >= 20)
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
