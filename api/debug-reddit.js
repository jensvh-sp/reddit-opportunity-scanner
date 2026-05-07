export const config = { runtime: "edge" };

export default async function handler(req) {
  const query = "best travel agency";
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=month&limit=3&type=link`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const text = await res.text();
    return new Response(
      JSON.stringify({ status: res.status, length: text.length, sample: text.slice(0, 300) }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
