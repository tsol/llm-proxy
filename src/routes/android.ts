import { Router, type Request, type Response } from 'express';
import {
  adbConnect,
  adbDisconnect,
  enableTcpip,
  getAndroidStatus,
  listAdbDevices,
  listUsbDevices,
} from '../services/android-bridge';

export const androidRouter = Router();

// GET /v1/android/status — full summary
androidRouter.get('/android/status', async (_req: Request, res: Response) => {
  try {
    const status = await getAndroidStatus();
    res.json(status);
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'Failed to get Android status',
        type: 'proxy_error',
      },
    });
  }
});

// GET /v1/android/devices/usb — USB devices via lsusb
androidRouter.get('/android/devices/usb', async (req: Request, res: Response) => {
  try {
    const vid = String(req.query.vid ?? '').trim() || undefined;
    const pid = String(req.query.pid ?? '').trim() || undefined;
    const devices = await listUsbDevices(vid, pid);
    res.json({ devices, count: devices.length });
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'Failed to list USB devices',
        type: 'proxy_error',
      },
    });
  }
});

// GET /v1/android/devices/adb — ADB devices
androidRouter.get('/android/devices/adb', async (_req: Request, res: Response) => {
  try {
    const devices = await listAdbDevices();
    res.json({ devices, count: devices.length });
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'Failed to list ADB devices',
        type: 'proxy_error',
      },
    });
  }
});

// POST /v1/android/tcpip/enable — switch USB device to TCP/IP mode
androidRouter.post('/android/tcpip/enable', async (req: Request, res: Response) => {
  const serial = String(req.body?.serial ?? '').trim();
  if (!serial) {
    res.status(400).json({
      error: {
        message: 'Missing required field: serial (ADB device serial or USB path)',
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const port = Number(req.body?.port) || undefined;

  try {
    const result = await enableTcpip(serial, port);
    if (result.ok) {
      res.json(result);
    } else {
      res.status(422).json(result);
    }
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'Failed to enable TCP/IP mode',
        type: 'proxy_error',
      },
    });
  }
});

// POST /v1/android/connect — connect to device via TCP/IP
androidRouter.post('/android/connect', async (req: Request, res: Response) => {
  const target = String(req.body?.target ?? '').trim();
  if (!target) {
    res.status(400).json({
      error: {
        message: 'Missing required field: target (e.g. 192.168.0.194:5555)',
        type: 'invalid_request_error',
      },
    });
    return;
  }

  try {
    const result = await adbConnect(target);
    if (result.ok) {
      res.json(result);
    } else {
      res.status(422).json(result);
    }
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'Failed to connect',
        type: 'proxy_error',
      },
    });
  }
});

// POST /v1/android/disconnect — disconnect TCP/IP device
androidRouter.post('/android/disconnect', async (req: Request, res: Response) => {
  const target = String(req.body?.target ?? '').trim() || undefined;

  try {
    const result = await adbDisconnect(target);
    res.json(result);
  } catch (err) {
    res.status(502).json({
      error: {
        message: err instanceof Error ? err.message : 'Failed to disconnect',
        type: 'proxy_error',
      },
    });
  }
});