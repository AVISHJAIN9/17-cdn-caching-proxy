export interface RouteDefinition {
  id: string;
  pathPrefix?: string;
  pathPattern?: string;
  host?: string;
  origin: string;
  headers?: Record<string, string>;
  priority?: number;
}

export interface RouteVersion {
  version: number;
  timestamp: number;
  author: string;
  routes: RouteDefinition[];
  diffSummary?: string;
}

export class RouteConfigurationManager {
  private currentVersion: number = 1;
  private currentRoutes: RouteDefinition[] = [];
  private readonly history: RouteVersion[] = [];

  constructor(initialRoutes: RouteDefinition[] = []) {
    this.currentRoutes = [...initialRoutes];
    this.history.push({
      version: 1,
      timestamp: Date.now(),
      author: 'system',
      routes: [...initialRoutes],
      diffSummary: 'Initial route configuration',
    });
  }

  public getRoutes(): RouteDefinition[] {
    return [...this.currentRoutes];
  }

  public getVersion(): number {
    return this.currentVersion;
  }

  public getHistory(): RouteVersion[] {
    return [...this.history];
  }

  public validateRoutes(routes: RouteDefinition[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const seenIds = new Set<string>();

    for (const r of routes) {
      if (!r.id || typeof r.id !== 'string') {
        errors.push('Every route must have a non-empty string id');
      } else if (seenIds.has(r.id)) {
        errors.push(`Duplicate route id: ${r.id}`);
      } else {
        seenIds.add(r.id);
      }

      if (!r.origin || typeof r.origin !== 'string') {
        errors.push(`Route ${r.id}: origin is required`);
      }

      if (r.pathPattern) {
        try {
          new RegExp(r.pathPattern);
        } catch {
          errors.push(`Route ${r.id}: invalid regular expression in pathPattern`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  public updateRoutes(params: {
    routes: RouteDefinition[];
    author?: string;
    dryRun?: boolean;
  }): { success: boolean; version?: number; diff?: string; errors?: string[] } {
    const validation = this.validateRoutes(params.routes);
    if (!validation.valid) {
      return { success: false, errors: validation.errors };
    }

    const diff = `Replaced ${this.currentRoutes.length} routes with ${params.routes.length} routes`;
    if (params.dryRun) {
      return { success: true, diff };
    }

    this.currentVersion++;
    this.currentRoutes = [...params.routes];
    this.history.push({
      version: this.currentVersion,
      timestamp: Date.now(),
      author: params.author ?? 'admin',
      routes: [...params.routes],
      diffSummary: diff,
    });

    return { success: true, version: this.currentVersion, diff };
  }

  public rollback(version: number): boolean {
    const found = this.history.find((h) => h.version === version);
    if (!found) return false;

    this.currentVersion++;
    this.currentRoutes = [...found.routes];
    this.history.push({
      version: this.currentVersion,
      timestamp: Date.now(),
      author: 'rollback',
      routes: [...found.routes],
      diffSummary: `Rolled back to version ${version}`,
    });
    return true;
  }
}
