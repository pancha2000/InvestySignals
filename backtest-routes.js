/**
 * InvestySignals — Backtest Routes v1.0
 *
 * Mount in server.js:
 *   const backtestRoutes = require('./backtest-routes');
 *   app.use('/api/backtest', backtestRoutes);
 *
 * Endpoints:
 *   POST /api/backtest/run      — start a backtest job
 *   GET  /api/backtest/status/:jobId — poll job status
 *   GET  /api/backtest/result/:jobId — get full result
 *   GET  /api/backtest/list     — list recent jobs (admin only)
 *   DELETE /api/backtest/:jobId — clear a job
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { runBacktest } = require('./backtest-engine');

/* ── In-memory job store (resets on server restart — fine for VPS) ── */
const jobs = new Map(); // jobId → jobObject

function makeJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ── Rate limiting: 1 active job per IP at a time ── */
const activeIPs = new Map(); // ip → jobId

/* ── Preset date ranges ── */
const DATE_RANGES = {
  '30d':  () => [Date.now() - 30  * 86400000, Date.now()],
  '3m':   () => [Date.now() - 90  * 86400000, Date.now()],
  '6m':   () => [Date.now() - 180 * 86400000, Date.now()],
  '1y':   () => [Date.now() - 365 * 86400000, Date.now()],
  'custom': (s, e) => [new Date(s).getTime(), new Date(e).getTime()],
};

/* ── Allowed symbols (Binance Futures USDT-M) ── */
const SYMBOL_RE = /^[A-Z]{2,10}USDT$/;

/* ══════════════════════════════════════════════════
   POST /api/backtest/run
   Body: { symbol: 'BTCUSDT', range: '1y' }
     or  { symbol: 'BTCUSDT', startDate: '2024-01-01', endDate: '2025-01-01' }
══════════════════════════════════════════════════ */
router.post('/run', (req, res) => {
  const { symbol, range, startDate, endDate } = req.body || {};
  const ip = req.ip || req.connection.remoteAddress;

  // Validate symbol
  const sym = (symbol || '').toUpperCase().trim();
  if (!SYMBOL_RE.test(sym)) {
    return res.status(400).json({ success: false, error: 'Invalid symbol. Use format: BTCUSDT' });
  }

  // Validate range
  let startMs, endMs;
  try {
    if (range && DATE_RANGES[range]) {
      [startMs, endMs] = DATE_RANGES[range](startDate, endDate);
    } else if (startDate && endDate) {
      [startMs, endMs] = DATE_RANGES.custom(startDate, endDate);
    } else {
      [startMs, endMs] = DATE_RANGES['1y']();
    }
    if (isNaN(startMs) || isNaN(endMs) || startMs >= endMs) throw new Error('Invalid date range');
    // Cap max range at 2 years
    if (endMs - startMs > 2 * 365 * 86400000) throw new Error('Max range is 2 years');
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }

  // Rate limit: block duplicate runs from same IP
  if (activeIPs.has(ip)) {
    const existing = jobs.get(activeIPs.get(ip));
    if (existing && existing.status === 'running') {
      return res.status(429).json({
        success: false,
        error: 'You already have a backtest running.',
        jobId: existing.id
      });
    }
  }

  const jobId = makeJobId();
  const job = {
    id: jobId,
    symbol: sym,
    range: range || 'custom',
    startMs,
    endMs,
    status: 'running',
    progress: 0,
    message: 'Starting…',
    result: null,
    error: null,
    createdAt: Date.now(),
    completedAt: null,
    ip,
  };

  jobs.set(jobId, job);
  activeIPs.set(ip, jobId);

  // Cleanup old jobs > 30min (keep latest 50)
  if (jobs.size > 50) {
    const cutoff = Date.now() - 30 * 60000;
    for (const [id, j] of jobs.entries()) {
      if (j.createdAt < cutoff && j.status !== 'running') {
        jobs.delete(id);
        break;
      }
    }
  }

  // Run async — don't await
  runBacktest(sym, startMs, endMs, (pct, msg) => {
    job.progress = pct;
    job.message  = msg;
  }).then(result => {
    job.status      = 'done';
    job.progress    = 100;
    job.message     = 'Complete';
    job.result      = result;
    job.completedAt = Date.now();
    activeIPs.delete(ip);
  }).catch(err => {
    job.status      = 'error';
    job.message     = err.message;
    job.error       = err.message;
    job.completedAt = Date.now();
    activeIPs.delete(ip);
  });

  res.json({ success: true, jobId, message: 'Backtest started' });
});

/* ══════════════════════════════════════════════════
   GET /api/backtest/status/:jobId
   Returns: { status, progress, message }
══════════════════════════════════════════════════ */
router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({
    success: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    symbol: job.symbol,
    error: job.error || null,
  });
});

/* ══════════════════════════════════════════════════
   GET /api/backtest/result/:jobId
   Returns full result (stats + all signals)
══════════════════════════════════════════════════ */
router.get('/result/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  if (job.status === 'running') {
    return res.json({ success: false, error: 'Still running', progress: job.progress, message: job.message });
  }
  if (job.status === 'error') {
    return res.status(500).json({ success: false, error: job.error });
  }
  res.json({ success: true, result: job.result });
});

/* ══════════════════════════════════════════════════
   DELETE /api/backtest/:jobId — clear result
══════════════════════════════════════════════════ */
router.delete('/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Not found' });
  if (job.status === 'running') return res.status(400).json({ success: false, error: 'Cannot delete running job' });
  jobs.delete(req.params.jobId);
  res.json({ success: true });
});

module.exports = router;
