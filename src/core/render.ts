/**
 * Render barrel (v1.5 refactor — split by command, zero behavior change).
 * The original single-file render module now lives in ./render/*; every
 * consumer keeps importing from '../core/render.ts' like before.
 */
export * from './render/shared.ts'
export * from './render/scan.ts'
export * from './render/delete.ts'
export * from './render/search.ts'
export * from './render/map.ts'
export * from './render/stats.ts'
export * from './render/global.ts'
export * from './render/baseline.ts'
export * from './render/why.ts'
