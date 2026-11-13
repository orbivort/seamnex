/**
 * Subpath barrel for `@seamnex/api-client/hooks`.
 *
 * The root barrel also declares the transport, the auth flow and the query client, so a screen
 * that wants a query hook currently pulls the whole request pipeline into its module graph. This
 * entry is additive — the root barrel is untouched and stays the canonical one.
 *
 * The `export *` form mirrors `src/index.ts` exactly, so the two cannot disagree about which
 * hook modules are public; a name that collides across modules is dropped by both barrels in the
 * same way.
 */
export * from './portal';
export * from './catalog';
export * from './instances';
export * from './jobs';
export * from './job-stream';
export * from './backups';
export * from './workflows';
export * from './governance';
export * from './admin';
export * from './recovery';
export * from './privacy';
