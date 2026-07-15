export type ChaincodeLanguage = 'go' | 'java' | 'node';

export type ChaincodeCatalogEntry = {
  id: string;
  displayName: string;
  language: ChaincodeLanguage;
  sourceRevision: string | null;
  metadata: Record<string, string>;
};

export interface ChaincodeCatalog {
  list(): Promise<ChaincodeCatalogEntry[]>;
  get(id: string): Promise<ChaincodeCatalogEntry | null>;
}

class EmptyChaincodeCatalog implements ChaincodeCatalog {
  async list(): Promise<ChaincodeCatalogEntry[]> {
    return [];
  }

  async get(_id: string): Promise<ChaincodeCatalogEntry | null> {
    return null;
  }
}

export function createChaincodeCatalog(): ChaincodeCatalog {
  return new EmptyChaincodeCatalog();
}
