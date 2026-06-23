// ============================================================
// LifeMax.in — Rank System
// ------------------------------------------------------------
// Pure logic + rendering helpers for the reputation-based rank
// ladder. Shared by thread-page.js and profile-page.js wherever a
// username is shown.
//
// IMPORTANT: glow / particles / badges decorate the USERNAME TEXT
// only — they are NEVER applied to a user's avatar/profile picture.
// The avatar always renders plain everywhere on the site.
//
// Ladder:
//   < 100   — no effects
//   100+    — glow (user picks 1 of 5 colors)
//   500+    — glow (stronger) + particles + badge slot #1
//   1000+   — glow (stronger still) + particles (more) + "Verified" badge
//   1500+   — glow (stronger again) + particles (more) + badge slot #2
//   every +500 after that — effects intensify again, alternating
//     between a generic new badge slot and bigger glow/particles
//
// Colors are stored on the user doc as `rankColor` (one of the 5
// keys below) and are user-editable from their own profile page.
// ============================================================

export const RANK_COLORS = {
  gold: "#D4AF37",
  blue: "#4A90D9",
  crimson: "#C0392B",
  emerald: "#27AE60",
  violet: "#8E44AD",
};

export const DEFAULT_RANK_COLOR = "gold";

/**
 * Returns the "tier" (how many 500-point thresholds have been
 * crossed, with 100 counting as a half-step) for a given reputation
 * value, plus the badges earned along the way.
 */
export function getRankInfo(reputation, rankColor) {
  const rep = reputation || 0;
  const color = RANK_COLORS[rankColor] ? rankColor : DEFAULT_RANK_COLOR;
  const colorHex = RANK_COLORS[color];

  if (rep < 100) {
    return {
      tier: 0,
      hasGlow: false,
      hasParticles: false,
      glowIntensity: 0,
      particleCount: 0,
      badges: [],
      color,
      colorHex,
    };
  }

  // tierLevel: 1 at 100rep, 2 at 500rep, 3 at 1000rep, 4 at 1500rep, 5 at 2000rep, ...
  let tierLevel;
  if (rep < 500) tierLevel = 1;
  else tierLevel = 1 + Math.floor((rep - 500) / 500) + 1;

  const hasParticles = rep >= 500;
  const glowIntensity = Math.min(1 + (tierLevel - 1) * 0.35, 4); // caps so it doesn't get absurd
  const particleCount = hasParticles ? Math.min(4 + (tierLevel - 2) * 3, 28) : 0;

  // Badges: "Verified" unlocks at 1000. After that, a new badge
  // unlocks every +1000 (so 2000, 3000, 4000, ...).
  const badges = [];
  if (rep >= 1000) badges.push({ label: "Verified", kind: "verified" });
  if (rep >= 2000) badges.push({ label: "Mod", kind: "mod" });
  if (rep >= 3000) badges.push({ label: "Lurker", kind: "lurker" });
  if (rep >= 4000) badges.push({ label: "God", kind: "god" });
  // Further +1000 milestones beyond this can be appended the same way.

  return {
    tier: tierLevel,
    hasGlow: true,
    hasParticles,
    glowIntensity,
    particleCount,
    badges,
    color,
    colorHex,
  };
}

/**
 * Returns an inline style string for a glow effect around an
 * element (avatar or username), scaled by intensity and colored
 * per the user's chosen rankColor.
 */
export function glowStyle(rankInfo) {
  if (!rankInfo.hasGlow) return "";
  const blur1 = 6 + rankInfo.glowIntensity * 4;
  const blur2 = 12 + rankInfo.glowIntensity * 8;
  return `filter: drop-shadow(0 0 ${blur1}px ${rankInfo.colorHex}) drop-shadow(0 0 ${blur2}px ${rankInfo.colorHex}88);`;
}

/**
 * Returns HTML for small badge pills to render next to a username.
 */
export function badgesHtml(rankInfo) {
  if (!rankInfo.badges || rankInfo.badges.length === 0) return "";
  return rankInfo.badges
    .map((b) => {
      const checkSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="width:10px;height:10px;"><path d="M20 6L9 17l-5-5"/></svg>`;
      return `<span class="rank-badge rank-badge-${b.kind}" title="${b.label}">${checkSvg}</span>`;
    })
    .join("");
}

/**
 * Returns HTML for a particle container to overlay near a username.
 * Particles are small CSS-animated dots; count + color come from
 * rankInfo. Caller should wrap the username in a relatively-positioned
 * element (see .rank-name-wrap in shared CSS) and place this inside it.
 */
export function particlesHtml(rankInfo) {
  if (!rankInfo.hasParticles) return "";
  let dots = "";
  for (let i = 0; i < rankInfo.particleCount; i++) {
    const delay = (Math.random() * 4).toFixed(2);
    const duration = (3 + Math.random() * 3).toFixed(2);
    const left = Math.floor(Math.random() * 100);
    dots += `<span class="rank-particle" style="left:${left}%; background:${rankInfo.colorHex}; animation-delay:${delay}s; animation-duration:${duration}s;"></span>`;
  }
  return `<span class="rank-particle-field">${dots}</span>`;
}
