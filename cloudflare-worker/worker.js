export default {
  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    const t = url.searchParams.get("t") || "month";
    const redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&t=${t}&limit=10&type=link&raw_json=1`;

    const res = await fetch(redditUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://www.reddit.com/",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
    });

    const text = await res.text();

    // Verify we got JSON and not an HTML anti-bot page
    if (!text.startsWith("{")) {
      return new Response(JSON.stringify({ error: "blocked", status: res.status }), {
        status: 403,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response(text, {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
