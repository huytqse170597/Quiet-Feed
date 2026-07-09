(function initializeQuietFeedRules(global) {
  "use strict";

  const PHRASES = Object.freeze({
    sponsored: [
      "sponsored",
      "được tài trợ",
      "duoc tai tro",
      "patrocinado",
      "sponsorisé",
      "sponsorise",
      "gesponsert",
      "sponsorizzato",
      "sponsorowane",
      "bersponsor",
      "ได้รับการสนับสนุน",
    ],
    suggested: [
      "suggested for you",
      "suggested post",
      "gợi ý cho bạn",
      "goi y cho ban",
      "đề xuất cho bạn",
      "de xuat cho ban",
      "recommandé pour vous",
      "recommande pour vous",
      "vorgeschlagen für dich",
      "vorgeschlagen fur dich",
      "sugerido para ti",
      "sugerido para você",
      "sugerido para voce",
    ],
    reels: ["reels", "reel", "thước phim", "thuoc phim"],
    stories: ["stories", "story", "tin"],
    groups: [
      "groups you may like",
      "groups you should join",
      "suggested groups",
      "nhóm bạn có thể thích",
      "nhom ban co the thich",
      "nhóm bạn nên tham gia",
      "nhom ban nen tham gia",
    ],
    people: [
      "people you may know",
      "people you might know",
      "những người bạn có thể biết",
      "nhung nguoi ban co the biet",
    ],
    birthdays: [
      "birthdays",
      "birthday reminders",
      "sinh nhật",
      "sinh nhat",
    ],
  });

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function includesPhrase(text, phrases) {
    const normalized = normalizeText(text);
    return phrases.some((phrase) => normalized.includes(normalizeText(phrase)));
  }

  function classifyFeedUnit(context, settings) {
    const text = normalizeText(context.text).slice(0, 2400);
    const pathname = normalizeText(context.pathname);

    if (settings.removeSponsored && includesPhrase(text, PHRASES.sponsored)) {
      return "sponsored";
    }

    if (
      settings.removeMarketplaceAds &&
      pathname.includes("/marketplace") &&
      includesPhrase(text, PHRASES.sponsored)
    ) {
      return "sponsored";
    }

    if (
      settings.removeSearchAds &&
      pathname.includes("/search") &&
      includesPhrase(text, PHRASES.sponsored)
    ) {
      return "sponsored";
    }

    if (settings.removeSuggested && includesPhrase(text, PHRASES.suggested)) {
      return "suggested";
    }

    if (settings.removeGroupSuggestions && includesPhrase(text, PHRASES.groups)) {
      return "suggested";
    }

    if (settings.removePeopleSuggestions && includesPhrase(text, PHRASES.people)) {
      return "suggested";
    }

    if (settings.removeReels && context.hasReelLink) {
      const isRecommendationShelf =
        context.reelLinkCount > 1 ||
        includesPhrase(text, PHRASES.reels) ||
        includesPhrase(text, PHRASES.suggested);
      if (!settings.allowFriendsReels || isRecommendationShelf) {
        return "reels";
      }
    }

    return null;
  }

  function matchesCustomRules(text, rules) {
    if (!Array.isArray(rules) || rules.length === 0) return false;
    const normalized = normalizeText(text).slice(0, 2400);
    return rules.some((rule) => {
      if (!rule || typeof rule !== "object") return false;
      if (rule.type === "regex") {
        try { return new RegExp(rule.pattern, "i").test(normalized); } catch { return false; }
      }
      return normalized.includes(normalizeText(rule.pattern || ""));
    });
  }

  const api = Object.freeze({
    PHRASES,
    normalizeText,
    includesPhrase,
    classifyFeedUnit,
    matchesCustomRules,
  });

  global.QuietFeedRules = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
