// The whole public portfolio as JSON, for MCP servers, scripts and other sites. Built at build time, served as a static file.
import type { APIRoute } from 'astro';
import { publicPortfolio } from '../data/public';

export const GET: APIRoute = () => Response.json(publicPortfolio());
