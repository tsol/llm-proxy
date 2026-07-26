import { Router, type Request, type Response } from 'express';
import { listAliases, getAlias, createAlias, updateAlias, deleteAlias, getMergedAliases } from '../services/alias-store';

export const aliasesRouter = Router();

// GET /v1/aliases — list all aliases (locked + user)
aliasesRouter.get('/aliases', (_req: Request, res: Response) => {
  try {
    const aliases = listAliases();
    res.json({
      object: 'list',
      data: aliases.map((a) => ({
        alias: a.alias,
        chain: a.chain,
        locked: a.locked,
        ...(a.updatedAt ? { updated_at: a.updatedAt } : {}),
      })),
    });
  } catch (err) {
    res.status(500).json({
      error: {
        message: err instanceof Error ? err.message : 'Failed to list aliases',
        type: 'proxy_error',
      },
    });
  }
});

// GET /v1/aliases/resolved — show merged alias map (env + store) used by the router
aliasesRouter.get('/aliases/resolved', (_req: Request, res: Response) => {
  try {
    const merged = getMergedAliases();
    const data: Record<string, string[]> = {};
    for (const [alias, chain] of merged) {
      data[alias] = chain;
    }
    res.json({ object: 'map', data });
  } catch (err) {
    res.status(500).json({
      error: {
        message: err instanceof Error ? err.message : 'Failed to resolve aliases',
        type: 'proxy_error',
      },
    });
  }
});

// GET /v1/aliases/:name — get a single alias
aliasesRouter.get('/aliases/:name', (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    const alias = getAlias(name);
    if (!alias) {
      res.status(404).json({
        error: {
          message: `Alias "${req.params.name}" not found`,
          type: 'invalid_request_error',
        },
      });
      return;
    }
    res.json({
      alias: alias.alias,
      chain: alias.chain,
      locked: alias.locked,
      ...(alias.updatedAt ? { updated_at: alias.updatedAt } : {}),
    });
  } catch (err) {
    res.status(500).json({
      error: {
        message: err instanceof Error ? err.message : 'Failed to get alias',
        type: 'proxy_error',
      },
    });
  }
});

// POST /v1/aliases — create a new user alias
aliasesRouter.post('/aliases', (req: Request, res: Response) => {
  try {
    const { alias, chain } = req.body;

    if (!alias || typeof alias !== 'string') {
      res.status(400).json({
        error: {
          message: '"alias" (string) is required',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    if (!Array.isArray(chain) || chain.length === 0) {
      res.status(400).json({
        error: {
          message: '"chain" must be a non-empty array of "provider/model" strings',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    for (const entry of chain) {
      if (typeof entry !== 'string' || !entry.includes('/')) {
        res.status(400).json({
          error: {
            message: `Each chain entry must be "provider/model" format, got: "${entry}"`,
            type: 'invalid_request_error',
          },
        });
        return;
      }
    }

    const created = createAlias(alias, chain);
    res.status(201).json({
      alias: created.alias,
      chain: created.chain,
      locked: created.locked,
      updated_at: created.updatedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create alias';
    const status = message.includes('locked') ? 403 : message.includes('already exists') ? 409 : 500;
    res.status(status).json({
      error: {
        message,
        type: 'proxy_error',
      },
    });
  }
});

// PUT /v1/aliases/:name — update an existing user alias (chain and/or rename)
aliasesRouter.put('/aliases/:name', (req: Request, res: Response) => {
  try {
    const { chain } = req.body;

    if (!Array.isArray(chain) || chain.length === 0) {
      res.status(400).json({
        error: {
          message: '"chain" must be a non-empty array of "provider/model" strings',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    for (const entry of chain) {
      if (typeof entry !== 'string' || !entry.includes('/')) {
        res.status(400).json({
          error: {
            message: `Each chain entry must be "provider/model" format, got: "${entry}"`,
            type: 'invalid_request_error',
          },
        });
        return;
      }
    }

    const updated = updateAlias(req.params.name as string, chain);
    res.json({
      alias: updated.alias,
      chain: updated.chain,
      locked: updated.locked,
      updated_at: updated.updatedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update alias';
    const status = message.includes('locked') ? 403 : message.includes('not found') ? 404 : 500;
    res.status(status).json({
      error: {
        message,
        type: 'proxy_error',
      },
    });
  }
});

// DELETE /v1/aliases/:name — delete a user alias
aliasesRouter.delete('/aliases/:name', (req: Request, res: Response) => {
  try {
    deleteAlias(req.params.name as string);
    res.json({ ok: true, message: `Alias "${req.params.name}" deleted` });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete alias';
    const status = message.includes('locked') ? 403 : message.includes('not found') ? 404 : 500;
    res.status(status).json({
      error: {
        message,
        type: 'proxy_error',
      },
    });
  }
});