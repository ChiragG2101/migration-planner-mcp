// The engine API. The CLI and MCP adapters call only what is exported here.
export { closeEngine, createEngine, ENGINE_VERSION, errorPayload, type Engine, type EngineOptions } from './engine.js';
export { ingest, scanRepo, type IngestOutput } from './scanRepo.js';
export { InputError, NotBuiltError, PermissionError } from '../security/errors.js';
export { parseLevel, type Level } from '../security/level.js';
export { IngestInput } from '../schema/ingest.js';
export { ScanRepoOutput } from '../schema/scan.js';
