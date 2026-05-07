export default {
  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    const t = url.searchParams.get("t") || "month";
    const redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&t=${t}&limit=10&type=link`;
    const res = await fetch(redditUrl, {
      headers: { "User-Agent": "OpportunityScanner/1.0" }
    });
    const data = await res.text();
    return new Response(data, {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
};
