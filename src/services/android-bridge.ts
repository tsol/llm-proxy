import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ============================================================
// Types
// ============================================================

export interface UsbDevice {
  bus: string;
  device: string;
  id: string;      // e.g. "1782:4003"
  description: string;
  raw: string;     // raw lsusb line
}

export interface AdbDevice {
  serial: string;
  state: string;       // "device", "offline", "unauthorized", "no permissions"
  transport: 'usb' | 'tcpip';
  usb_path?: string;
  product?: string;
  model?: string;
  device_info?: string;
  raw: string;
}

export interface AndroidStatus {
  usb_devices: UsbDevice[];
  adb_devices: AdbDevice[];
  tcpip_connections: AdbDevice[];
  adb_server_running: boolean;
}

export interface TcpipEnableResult {
  ok: boolean;
  serial: string;
  ip: string | null;
  port: number;
  adb_connect: string | null;
  interfaces: NetworkInterface[];
  message: string;
}

export interface NetworkInterface {
  name: string;
  ip: string;
}

// ============================================================
// Config helpers
// ============================================================

let config = {
  adbPath: 'adb',
  tcpipPort: 5555,
  targetVid: '',
  targetPid: '',
};

export function configureAndroidBridge(opts: {
  adbPath?: string;
  tcpipPort?: number;
  targetVid?: string;
  targetPid?: string;
}): void {
  config = { ...config, ...opts };
}

// ============================================================
// Low-level command runners
// ============================================================

async function runAdb(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync(config.adbPath, args, {
    timeout: timeoutMs,
    env: { ...process.env, ADB_LIBUSB: '0' },
  });
  const output = (stdout || '').trim();
  const errout = (stderr || '').trim();
  // adb sometimes writes info to stderr
  return output || errout;
}

async function runLsusb(): Promise<string> {
  const { stdout } = await execFileAsync('lsusb', [], { timeout: 10_000 });
  return stdout.trim();
}

// ============================================================
// USB device discovery
// ============================================================

export async function listUsbDevices(filterVid?: string, filterPid?: string): Promise<UsbDevice[]> {
  const output = await runLsusb();
  const lines = output.split('\n').filter(Boolean);
  const devices: UsbDevice[] = [];

  for (const line of lines) {
    // Format: "Bus 001 Device 019: ID 1782:4003 Spreadtrum Communications Inc. itel A27"
    const match = line.match(
      /^Bus\s+(\d+)\s+Device\s+(\d+):\s+ID\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s+(.+)$/,
    );
    if (match) {
      const vid = match[3];
      const pid = match[4];
      if (filterVid && vid.toLowerCase() !== filterVid.toLowerCase()) continue;
      if (filterPid && pid.toLowerCase() !== filterPid.toLowerCase()) continue;

      devices.push({
        bus: match[1],
        device: match[2],
        id: `${vid}:${pid}`,
        description: match[5].trim(),
        raw: line,
      });
    }
  }

  return devices;
}

// ============================================================
// ADB device discovery
// ============================================================

export async function listAdbDevices(): Promise<AdbDevice[]> {
  const output = await runAdb(['devices', '-l']);
  const lines = output.split('\n').slice(1); // skip "List of devices attached"
  const devices: AdbDevice[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const state = parts[1] || 'unknown';

    // Determine transport
    const isTcpip = serial.includes(':');
    const transport: 'usb' | 'tcpip' = isTcpip ? 'tcpip' : 'usb';

    // Parse device info flags
    const flags = parts.slice(2).join(' ');
    const usbMatch = flags.match(/usb:([^\s]+)/);
    const productMatch = flags.match(/product:([^\s]+)/);
    const modelMatch = flags.match(/model:([^\s]+)/);

    devices.push({
      serial,
      state,
      transport,
      usb_path: usbMatch?.[1],
      product: productMatch?.[1],
      model: modelMatch?.[1],
      device_info: flags,
      raw: trimmed,
    });
  }

  return devices;
}

// ============================================================
// ADB server management
// ============================================================

export async function isAdbServerRunning(): Promise<boolean> {
  try {
    const output = await runAdb(['devices'], 5_000);
    return output.includes('List of devices attached');
  } catch {
    return false;
  }
}

export async function startAdbServer(): Promise<void> {
  await runAdb(['start-server'], 15_000);
}

export async function killAdbServer(): Promise<void> {
  await runAdb(['kill-server'], 10_000);
}

// ============================================================
// Device network info
// ============================================================

export async function getDeviceIp(serial: string): Promise<{
  ip: string | null;
  interfaces: NetworkInterface[];
}> {
  const interfaces: NetworkInterface[] = [];

  try {
    // Try: ip route (most reliable)
    const routeOut = await runAdb(['-s', serial, 'shell', 'ip', 'route', 'show', 'default']);
    const routeMatch = routeOut.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
    const defaultIp = routeMatch?.[1] || null;

    // Get all interfaces
    const ifaces = await runAdb(['-s', serial, 'shell', 'ip', '-4', '-br', 'addr', 'show']);
    for (const line of ifaces.split('\n')) {
      const ifMatch = line.match(/^(\S+)\s+\S+\s+(\d+\.\d+\.\d+\.\d+)/);
      if (ifMatch && ifMatch[1] !== 'lo') {
        interfaces.push({ name: ifMatch[1], ip: ifMatch[2] });
      }
    }

    // Best IP: wlan0 > default route > first non-loopback
    let ip = defaultIp;
    if (!ip) {
      const wlan = interfaces.find((i) => i.name.startsWith('wlan'));
      ip = wlan?.ip ?? interfaces[0]?.ip ?? null;
    }

    return { ip, interfaces };
  } catch (err) {
    return {
      ip: null,
      interfaces: [],
    };
  }
}

// ============================================================
// TCP/IP mode
// ============================================================

export async function enableTcpip(
  serial: string,
  port: number = config.tcpipPort,
): Promise<TcpipEnableResult> {
  // 1. Check device state
  const devices = await listAdbDevices();
  const target = devices.find((d) => d.serial === serial);
  if (!target) {
    return {
      ok: false,
      serial,
      ip: null,
      port,
      adb_connect: null,
      interfaces: [],
      message: `Device ${serial} not found in ADB devices.`,
    };
  }

  if (target.transport === 'tcpip') {
    // Already on TCP/IP, get its current IP
    const net = await getDeviceIp(serial);
    return {
      ok: true,
      serial,
      ip: net.ip,
      port,
      adb_connect: net.ip ? `${net.ip}:${port}` : serial,
      interfaces: net.interfaces,
      message: `Device ${serial} is already on TCP/IP.`,
    };
  }

  if (target.state !== 'device') {
    return {
      ok: false,
      serial,
      ip: null,
      port,
      adb_connect: null,
      interfaces: [],
      message: `Device ${serial} is in state "${target.state}" — cannot enable TCP/IP. Check USB debugging authorization.`,
    };
  }

  // 2. Get IP before switching (USB shell is more reliable)
  const netBefore = await getDeviceIp(serial);

  // 3. Enable TCP/IP mode
  try {
    const out = await runAdb(['-s', serial, 'tcpip', String(port)], 20_000);
    if (out.includes('restarting')) {
      // Wait for device to come back on TCP/IP
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const ip = netBefore.ip;
      const connectStr = ip ? `${ip}:${port}` : null;

      if (connectStr) {
        // Try to connect via TCP/IP
        try {
          await runAdb(['connect', connectStr], 10_000);
        } catch {
          // Connect may fail initially — that's okay, the device is still in TCP/IP mode
        }
      }

      return {
        ok: true,
        serial,
        ip: netBefore.ip,
        port,
        adb_connect: connectStr,
        interfaces: netBefore.interfaces,
        message: `TCP/IP mode enabled on port ${port}. Device is restarting ADB daemon.${connectStr ? ` Connect via: adb connect ${connectStr}` : ''}`,
      };
    }

    return {
      ok: true,
      serial,
      ip: netBefore.ip,
      port,
      adb_connect: netBefore.ip ? `${netBefore.ip}:${port}` : null,
      interfaces: netBefore.interfaces,
      message: out || 'TCP/IP command sent.',
    };
  } catch (err) {
    return {
      ok: false,
      serial,
      ip: null,
      port,
      adb_connect: null,
      interfaces: netBefore.interfaces,
      message: `Failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

// ============================================================
// Connect / Disconnect
// ============================================================

export async function adbConnect(target: string): Promise<{ ok: boolean; message: string }> {
  try {
    const out = await runAdb(['connect', target], 15_000);
    if (out.includes('connected') || out.includes('already connected')) {
      return { ok: true, message: out };
    }
    return { ok: false, message: out };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Connection failed',
    };
  }
}

export async function adbDisconnect(target?: string): Promise<{ ok: boolean; message: string }> {
  const args = ['disconnect'];
  if (target) args.push(target);
  try {
    const out = await runAdb(args, 10_000);
    return { ok: true, message: out };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Disconnect failed',
    };
  }
}

// ============================================================
// Status summary
// ============================================================

export async function getAndroidStatus(): Promise<AndroidStatus> {
  const [usb_devices, adb_devices, serverRunning] = await Promise.all([
    listUsbDevices().catch(() => [] as UsbDevice[]),
    listAdbDevices().catch(() => [] as AdbDevice[]),
    isAdbServerRunning().catch(() => false),
  ]);

  const tcpip_connections = adb_devices.filter((d) => d.transport === 'tcpip');

  return {
    usb_devices,
    adb_devices,
    tcpip_connections,
    adb_server_running: serverRunning,
  };
}