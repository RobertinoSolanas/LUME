/* ------------------------------------------------------------------
 * lume-voice.js – lightweight voice / description helper for LUME
 * Author: ChatGPT – MIT‑licensed
 * ------------------------------------------------------------------*/
(function (global) {
  const DEFAULT_LANGS = ["de", "en"];

  /** fetch REST summary */
  async function wikiSummary(lang, title) {
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("no page");
    const j = await r.json();
    if (!j.extract) throw new Error("empty summary");
    return j.extract;
  }

  /** if direct summary fails, search Wikipedia and fetch first match */
  async function wikiSummaryFlexible(lang, title) {
    try {
      return await wikiSummary(lang, title);
    } catch (_) {
      // Fallback: search API
      const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        title
      )}&utf8=&format=json&origin=*`;
      const s = await fetch(searchUrl);
      if (!s.ok) throw new Error("search failed");
      const data = await s.json();
      const hits = data?.query?.search;
      if (!hits || hits.length === 0) throw new Error("no matches");
      return await wikiSummary(lang, hits[0].title);
    }
  }

  /** speak */
  function speak(text, lang = "de-DE") {
    if (!("speechSynthesis" in global)) return;
    global.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    global.speechSynthesis.speak(u);
  }

  /** main */
  async function describe(title, opt = {}) {
    const { langPrefer = "de", autoplay = true, onResult = () => {}, onError = () => {} } = opt;
    const langs = [langPrefer, ...DEFAULT_LANGS.filter((l) => l !== langPrefer)];
    let summary = "";
    let usedLang = "";
    for (const lang of langs) {
      try {
        summary = await wikiSummaryFlexible(lang, title);
        usedLang = lang;
        break;
      } catch (_) {
        /* continue */
      }
    }
    if (!summary) {
      onError(new Error("No Wikipedia summary found"));
      return;
    }
    if (autoplay) speak(summary, usedLang + "-DE");
    onResult(summary, usedLang);
  }

  global.lumeVoice = { describe };
})(typeof window !== "undefined" ? window : this);
