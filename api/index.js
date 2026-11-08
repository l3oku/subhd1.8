import { dispatch } from '../src/server.js';

// Serverless entry point. vercel.json rewrites every path here (see
// REWRITE_PATH_PARAM in src/server.js), so one function serves the whole addon.
export default function handler(req, res) {
  return dispatch(req, res);
}
