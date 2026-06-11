/**
 * NetdocEmbed.tsx - Backward compatible re-export
 * 
 * All embed functionality has been split into modular files in ./embed/
 * This file re-exports everything for backward compatibility.
 */

// Re-export everything from the embed module
export * from './embed';

// Default export for backward compatibility
export { default } from './embed/NetdocEmbed';
