// Vitest runs server-side services directly, outside Next's compiler aliases.
// The runtime boundary is enforced by Next in application builds; this empty
// module only gives the node test harness the same server-side resolution.
export {};
