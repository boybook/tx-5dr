import { createLogger } from '../utils/logger.js';
import {
  loadManagedLiveKitSettingsFromConfigFile,
  writeManagedLiveKitRuntimeConfig,
} from './LiveKitRuntimeConfig.js';

const logger = createLogger('LiveKitConfigCli');

type CliArgs = {
  appConfig?: string;
  credentialFile?: string;
  output?: string;
  signalPort?: string;
  tcpPort?: string;
  udpStart?: string;
  udpEnd?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith('--') || value == null) {
      continue;
    }

    switch (key) {
      case '--app-config':
        parsed.appConfig = value;
        index += 1;
        break;
      case '--credential-file':
        parsed.credentialFile = value;
        index += 1;
        break;
      case '--output':
        parsed.output = value;
        index += 1;
        break;
      case '--signal-port':
        parsed.signalPort = value;
        index += 1;
        break;
      case '--tcp-port':
        parsed.tcpPort = value;
        index += 1;
        break;
      case '--udp-start':
        parsed.udpStart = value;
        index += 1;
        break;
      case '--udp-end':
        parsed.udpEnd = value;
        index += 1;
        break;
      default:
        break;
    }
  }

  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.credentialFile) {
    process.env.LIVEKIT_CREDENTIALS_FILE = args.credentialFile;
  }
  if (args.output) {
    process.env.LIVEKIT_CONFIG_PATH = args.output;
  }
  if (args.signalPort) {
    process.env.LIVEKIT_SIGNAL_PORT = args.signalPort;
  }
  if (args.tcpPort) {
    process.env.LIVEKIT_TCP_PORT = args.tcpPort;
  }
  if (args.udpStart) {
    process.env.LIVEKIT_UDP_PORT_START = args.udpStart;
  }
  if (args.udpEnd) {
    process.env.LIVEKIT_UDP_PORT_END = args.udpEnd;
  }

  const settings = args.appConfig
    ? await loadManagedLiveKitSettingsFromConfigFile(args.appConfig)
    : await loadManagedLiveKitSettingsFromConfigFile('');

  const result = await writeManagedLiveKitRuntimeConfig({
    settings,
    outputPath: args.output ?? undefined,
  });

  if (!result) {
    throw new Error('Managed LiveKit runtime config could not be written');
  }

  logger.info('LiveKit runtime config CLI completed', {
    outputPath: result.outputPath,
    networkMode: result.settings.networkMode,
    nodeIp: result.settings.nodeIp,
  });
}

main().catch((error) => {
  logger.error('LiveKit runtime config CLI failed', error);
  process.exitCode = 1;
});
