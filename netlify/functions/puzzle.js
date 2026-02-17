// Fetches Guardian crossword data by type
// Usage: /.netlify/functions/puzzle?type=quick
//        /.netlify/functions/puzzle?type=quick&number=17406

exports.handler = async (event) => {
  const type = event.queryStringParameters?.type || "quick";
  const specificNum = event.queryStringParameters?.number;

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "public, max-age=1800",
  };

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  try {
    let puzzleNum = specificNum
      ? parseInt(specificNum)
      : estimatePuzzleNumber(type);

    let data = null;
    let lastErr = null;
    let triedNums = [];

    for (let attempt = 0; attempt < 8; attempt++) {
      const tryNum = puzzleNum - attempt;
      triedNums.push(tryNum);

      try {
        data = await fetchFromGuardianPage(type, tryNum);
        if (data) break;
      } catch (e) {
        lastErr = `Puzzle ${tryNum}: ${e.message}`;
      }
    }

    if (!data) {
      throw new Error(
        `Could not find a valid ${type} puzzle. Tried: ${triedNums.join(", ")}. Last error: ${lastErr || "unknown"}`
      );
    }

    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    console.error("Puzzle fetch error:", e.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message }),
    };
  }
};

async function fetchFromGuardianPage(type, num) {
  const url = `https://www.theguardian.com/crosswords/${type}/${num}`;
  console.log(`Trying: ${url}`);

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9,en-US;q=0.8",
      Referer: "https://www.theguardian.com/crosswords",
    },
    redirect: "follow",
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const data = extractPuzzleData(html);

  if (!data) throw new Error("Could not extract data from page");
  if (!data.entries || data.entries.length === 0) {
    throw new Error("No entries in puzzle data");
  }

  return data;
}

function extractPuzzleData(html) {
  // PATTERN 1 (current 2025-2026): <gu-island name="CrosswordComponent" props='{"data":{...}}'>
  // The Guardian now uses Web Components. The puzzle JSON lives in a props attribute.

  // 1a: Single-quoted props attribute
  let match = html.match(
    /<gu-island[^>]*name="CrosswordComponent"[^>]*props='([^']+)'/
  );
  if (!match) {
    match = html.match(
      /<gu-island[^>]*props='([^']+)'[^>]*name="CrosswordComponent"/
    );
  }
  if (match) {
    try {
      const wrapper = JSON.parse(match[1]);
      if (wrapper.data && wrapper.data.entries) return wrapper.data;
    } catch (e) {
      console.log("gu-island single-quote parse failed:", e.message);
    }
  }

  // 1b: Double-quoted props attribute (HTML-encoded with &quot; etc.)
  match = html.match(
    /<gu-island[^>]*name=(?:"|&quot;)CrosswordComponent(?:"|&quot;)[^>]*props="([^"]+)"/
  );
  if (!match) {
    match = html.match(
      /<gu-island[^>]*props="([^"]+)"[^>]*name=(?:"|&quot;)CrosswordComponent/
    );
  }
  if (match) {
    try {
      const decoded = decodeHtmlEntities(match[1]);
      const wrapper = JSON.parse(decoded);
      if (wrapper.data && wrapper.data.entries) return wrapper.data;
    } catch (e) {
      console.log("gu-island double-quote parse failed:", e.message);
    }
  }

  // 1c: Generic gu-island with crossword entries
  match = html.match(/<gu-island[^>]*props='(\{[^']*"entries"[^']*\})'/);
  if (match) {
    try {
      const wrapper = JSON.parse(match[1]);
      const data = wrapper.data || wrapper;
      if (data.entries && data.entries.length > 0) return data;
    } catch {}
  }

  // 1d: HTML-encoded version of the generic fallback
  match = html.match(/<gu-island[^>]*props="([^"]*entries[^"]*)"[^>]*>/);
  if (match) {
    try {
      const decoded = decodeHtmlEntities(match[1]);
      const wrapper = JSON.parse(decoded);
      const data = wrapper.data || wrapper;
      if (data.entries && data.entries.length > 0) return data;
    } catch {}
  }

  // PATTERN 2 (legacy): data-crossword-data='...'
  match = html.match(/data-crossword-data='([^']+)'/);
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      if (data.entries) return data;
    } catch {}
  }

  match = html.match(/data-crossword-data="([^"]+)"/);
  if (match) {
    try {
      const data = JSON.parse(decodeHtmlEntities(match[1]));
      if (data.entries) return data;
    } catch {}
  }

  // PATTERN 3: JSON blob in page with crossword structure
  match = html.match(
    /(\{"id"\s*:\s*"crosswords[^"]*"[\s\S]*?"entries"\s*:\s*\[[\s\S]*?\]\s*\})/
  );
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      if (data.entries) return data;
    } catch {}
  }

  return null;
}

// Calculate expected puzzle number from date
function estimatePuzzleNumber(type) {
  const now = new Date();
  const todayUTC = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  );

  if (type === "quick") {
    // Quick #17405 = Monday Feb 17, 2026 - publishes Mon-Sat (6/week)
    const refDate = new Date(Date.UTC(2026, 1, 17));
    const refNum = 17405;
    const daysDiff = Math.floor(
      (todayUTC - refDate) / (1000 * 60 * 60 * 24)
    );

    let weekdays = 0;
    if (daysDiff >= 0) {
      for (let i = 0; i <= daysDiff; i++) {
        const d = new Date(refDate.getTime() + i * 86400000);
        if (d.getUTCDay() !== 0) weekdays++;
      }
      return refNum + weekdays - 1;
    } else {
      for (let i = 0; i > daysDiff; i--) {
        const d = new Date(refDate.getTime() + i * 86400000);
        if (d.getUTCDay() !== 0) weekdays++;
      }
      return refNum - weekdays;
    }
  }

  if (type === "everyman") {
    const refDate = new Date(Date.UTC(2026, 1, 16));
    const refNum = 4123;
    const daysDiff = Math.floor(
      (todayUTC - refDate) / (1000 * 60 * 60 * 24)
    );
    const weeksDiff = Math.round(daysDiff / 7);
    return refNum + weeksDiff;
  }

  return 17405;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
      String.fromCharCode(parseInt(n, 16))
    );
}
