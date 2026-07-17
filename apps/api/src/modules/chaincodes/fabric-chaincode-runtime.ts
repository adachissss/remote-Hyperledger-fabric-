import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ContractExecutionMode, ContractExecutionRequest } from '@plus-fabric/shared';

import type { LedgerPeerContext } from '../ledger/fabric-ledger-runtime.js';

const execFileAsync = promisify(execFile);

export type RuntimeInstalledPackage = {
  packageId: string;
  label: string;
};

export type RuntimeCommittedDefinition = {
  name: string;
  version: string;
  sequence: number;
  endorsementPlugin: string | null;
  validationPlugin: string | null;
  validationParameterBase64: string;
  approvals: Record<string, boolean>;
};

export type ChaincodeOrdererContext = {
  address: string;
  host: string;
  tlsRootCertPath: string;
};

export type RuntimeContractResult = {
  transactionId: string | null;
  responseStatus: number | null;
  output: Uint8Array;
};

export interface FabricChaincodeRuntime {
  queryInstalled(peer: LedgerPeerContext): Promise<RuntimeInstalledPackage[]>;
  queryCommitted(
    peer: LedgerPeerContext,
    channelName: string,
  ): Promise<RuntimeCommittedDefinition[]>;
  executeContract(input: {
    mode: ContractExecutionMode;
    request: ContractExecutionRequest;
    invokingPeer: LedgerPeerContext;
    targetPeers: LedgerPeerContext[];
    orderer: ChaincodeOrdererContext;
  }): Promise<RuntimeContractResult>;
}

export class FabricCliChaincodeRuntime implements FabricChaincodeRuntime {
  async queryInstalled(peer: LedgerPeerContext): Promise<RuntimeInstalledPackage[]> {
    const { stdout } = await runPeer(peer, [
      'lifecycle',
      'chaincode',
      'queryinstalled',
      '--output',
      'json',
    ]);
    const parsed = parsePeerJson(stdout, 'installed chaincode packages') as {
      installed_chaincodes?: unknown;
    };
    if (!Array.isArray(parsed.installed_chaincodes)) return [];
    return parsed.installed_chaincodes.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const packageId = Reflect.get(entry, 'package_id');
      const label = Reflect.get(entry, 'label');
      return typeof packageId === 'string' && typeof label === 'string'
        ? [{ packageId, label }]
        : [];
    });
  }

  async queryCommitted(
    peer: LedgerPeerContext,
    channelName: string,
  ): Promise<RuntimeCommittedDefinition[]> {
    const { stdout } = await runPeer(peer, [
      'lifecycle',
      'chaincode',
      'querycommitted',
      '--channelID',
      channelName,
      '--output',
      'json',
    ]);
    const parsed = parsePeerJson(stdout, `committed definitions on channel "${channelName}"`) as {
      chaincode_definitions?: unknown;
    };
    if (!Array.isArray(parsed.chaincode_definitions)) return [];
    return parsed.chaincode_definitions.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const name = Reflect.get(entry, 'name');
      const version = Reflect.get(entry, 'version');
      const sequence = Reflect.get(entry, 'sequence');
      if (
        typeof name !== 'string' ||
        typeof version !== 'string' ||
        (typeof sequence !== 'number' && typeof sequence !== 'string')
      ) {
        return [];
      }
      const parsedSequence = Number(sequence);
      if (!Number.isInteger(parsedSequence) || parsedSequence < 1) return [];
      const endorsementPlugin = Reflect.get(entry, 'endorsement_plugin');
      const validationPlugin = Reflect.get(entry, 'validation_plugin');
      const validationParameter = Reflect.get(entry, 'validation_parameter');
      const approvalsValue = Reflect.get(entry, 'approvals');
      const approvals: Record<string, boolean> = {};
      if (approvalsValue && typeof approvalsValue === 'object' && !Array.isArray(approvalsValue)) {
        for (const [mspId, approved] of Object.entries(approvalsValue)) {
          if (typeof approved === 'boolean') approvals[mspId] = approved;
        }
      }
      return [
        {
          name,
          version,
          sequence: parsedSequence,
          endorsementPlugin: typeof endorsementPlugin === 'string' ? endorsementPlugin : null,
          validationPlugin: typeof validationPlugin === 'string' ? validationPlugin : null,
          validationParameterBase64:
            typeof validationParameter === 'string' ? validationParameter : '',
          approvals,
        },
      ];
    });
  }

  async executeContract(input: {
    mode: ContractExecutionMode;
    request: ContractExecutionRequest;
    invokingPeer: LedgerPeerContext;
    targetPeers: LedgerPeerContext[];
    orderer: ChaincodeOrdererContext;
  }): Promise<RuntimeContractResult> {
    const action = input.mode === 'evaluate' ? 'query' : 'invoke';
    const args = [
      'chaincode',
      action,
      '-C',
      input.request.channelName,
      '-n',
      input.request.chaincodeName,
      '-c',
      JSON.stringify({ Args: [input.request.functionName, ...input.request.arguments] }),
    ];

    if (Object.keys(input.request.transient).length > 0) {
      args.push(
        '--transient',
        JSON.stringify(
          Object.fromEntries(
            Object.entries(input.request.transient).map(([key, value]) => [
              key,
              Buffer.from(value, 'utf8').toString('base64'),
            ]),
          ),
        ),
      );
    }

    if (input.mode === 'submit') {
      args.push(
        '-o',
        input.orderer.address,
        '--ordererTLSHostnameOverride',
        input.orderer.host,
        '--tls',
        '--cafile',
        input.orderer.tlsRootCertPath,
      );
      for (const peer of input.targetPeers) {
        args.push('--peerAddresses', peer.address, '--tlsRootCertFiles', peer.tlsRootCertPath);
      }
      args.push('--waitForEvent', '--waitForEventTimeout', '30s');
    }

    const { stdout, stderr } = await runPeer(input.invokingPeer, args, 45_000);
    const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    const outputText = extractPayload(combined) ?? (stdout.trim() || stderr.trim());
    const transactionId =
      combined.match(/txid\s*\[([A-Fa-f0-9]+)\]/)?.[1] ??
      combined.match(/txid\s*[:=]\s*([A-Fa-f0-9]+)/i)?.[1] ??
      null;
    const responseStatusText = combined.match(/status\s*:\s*(\d+)/i)?.[1];
    return {
      transactionId,
      responseStatus: responseStatusText ? Number(responseStatusText) : input.mode === 'evaluate' ? 200 : null,
      output: Buffer.from(outputText, 'utf8'),
    };
  }
}

async function runPeer(peer: LedgerPeerContext, args: string[], timeout = 20_000) {
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
      timeout,
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

function parsePeerJson(stdout: string, description: string): unknown {
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) throw new Error(`Fabric peer did not return ${description} as JSON.`);
  return JSON.parse(stdout.slice(jsonStart));
}

function extractPayload(output: string): string | null {
  const match = output.match(/payload:("(?:\\.|[^"\\])*")/s)?.[1];
  if (!match) return null;
  try {
    return JSON.parse(match) as string;
  } catch {
    return null;
  }
}
