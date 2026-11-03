// 2.12.3 reactions (FR-330): one emoji per person per chat message or session update, from this
// fixed set, in this order. The SQL twin checks the same strings (siosia_reaction_ok) — keep both
// in step; an emoji outside the set is bad_input.

export const REACTIONS = ["❤️", "👍", "😂", "😮", "😢", "🙏"] as const;

export type ReactionEmoji = (typeof REACTIONS)[number];

export const isReaction = (x: unknown): x is ReactionEmoji => typeof x === "string" && (REACTIONS as readonly string[]).includes(x);

/** Reactions a person may set on different items within REACT_RATE_MS (a toggle on one item counts once). */
export const REACT_RATE_N = 60;
export const REACT_RATE_MS = 10 * 60_000;
