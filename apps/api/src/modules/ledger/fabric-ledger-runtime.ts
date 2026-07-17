import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type LedgerPeerContext = {
  executable: string;
  workspaceRoot: string;
  configPath: string;
  composeProject: string;
  organizationName: string;
  mspId: string;
  address: string;
  host: string;
  adminMspPath: string;
  tlsRootCertPath: string;
  fabricConfigPath: string;
};

export type LedgerChannelInfo = {
  height: string;
  currentBlockHash: string;
  previousBlockHash: string;
};

export interface FabricLedgerRuntime {
  listChannels(peer: LedgerPeerContext): Promise<string[]>;
  getChannelInfo(peer: LedgerPeerContext, channelName: string): Promise<LedgerChannelInfo>;
  fetchBlock(
    peer: LedgerPeerContext,
    channelName: string,
    blockNumber: string,
  ): Promise<Uint8Array>;
}

export class FabricCliLedgerRuntime implements FabricLedgerRuntime {
  async listChannels(peer: LedgerPeerContext): Promise<string[]> {
    const { stdout } = await runPeer(peer, ['channel', 'list']);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          line !== 'Channels peers has joined:' &&
          /^[a-z][a-z0-9.-]*$/.test(line),
      );
  }

  async getChannelInfo(
    peer: LedgerPeerContext,
    channelName: string,
  ): Promise<LedgerChannelInfo> {
    const { stdout } = await runPeer(peer, ['channel', 'getinfo', '-c', channelName]);
    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0) {
      throw new Error(`Fabric peer did not return blockchain info for channel "${channelName}".`);
    }
    const parsed = JSON.parse(stdout.slice(jsonStart)) as {
      height?: unknown;
      currentBlockHash?: unknown;
      previousBlockHash?: unknown;
    };
    if (
      (typeof parsed.height !== 'number' && typeof parsed.height !== 'string') ||
      typeof parsed.currentBlockHash !== 'string' ||
      typeof parsed.previousBlockHash !== 'string'
    ) {
      throw new Error(`Fabric peer returned invalid blockchain info for channel "${channelName}".`);
    }
    return {
      height: String(parsed.height),
      currentBlockHash: parsed.currentBlockHash,
      previousBlockHash: parsed.previousBlockHash,
    };
  }

  async fetchBlock(
    peer: LedgerPeerContext,
    channelName: string,
    blockNumber: string,
  ): Promise<Uint8Array> {
    const { stdout } = await runPeer(peer, [
      'chaincode',
      'query',
      '-C',
      channelName,
      '-n',
      'qscc',
      '-c',
      JSON.stringify({ Args: ['GetBlockByNumber', channelName, blockNumber] }),
      '--hex',
    ]);
    const hex = stdout.trim();
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) {
      throw new Error(`QSCC returned an invalid block payload for block ${blockNumber}.`);
    }
    return Buffer.from(hex, 'hex');
  }
}

async function runPeer(peer: LedgerPeerContext, args: string[]) {
  try {
    return await execFileAsync(peer.executable, args, {
      cwd: peer.workspaceRoot,
      env: {
        ...process.env,
        CONFIG_FILE: peer.configPath,
        COMPOSE_PROJECT_NAME: peer.composeProject,
        CORE_PEER_ADDRESS: peer.address,
        CORE_PEER_LOCALMSPID: peer.mspId,
        CORE_PEER_MSPCONFIGPATH: peer.adminMspPath,
        CORE_PEER_TLS_ENABLED: 'true',
        CORE_PEER_TLS_ROOTCERT_FILE: peer.tlsRootCertPath,
        FABRIC_CFG_PATH: peer.fabricConfigPath,
      },
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (error) {
    const details =
      error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : '';
    throw new Error(
      details
        ? `Fabric peer command failed: ${details}`
        : error instanceof Error
          ? error.message
          : 'Fabric peer command failed.',
    );
  }
}
