
export type ServiceFactory<T> = () => T | Promise<T>;

export class Container {
  private registry = new Map<symbol, unknown>();
  private factories = new Map<symbol, ServiceFactory<unknown>>();
  private singletons = new Set<symbol>();
  private singletonCache = new Map<symbol, unknown>();

  register<T>(token: symbol, factory: ServiceFactory<T>, singleton = false): this {
    this.factories.set(token, factory as ServiceFactory<unknown>);
    if (singleton) this.singletons.add(token);
    return this;
  }

  async resolve<T>(token: symbol): Promise<T> {
    if (this.singletons.has(token)) {
      if (!this.singletonCache.has(token)) {
        const factory = this.factories.get(token);
        if (!factory) throw new Error(`Unknown service: ${token.toString()}`);
        const instance = await factory();
        this.singletonCache.set(token, instance);
      }
      return this.singletonCache.get(token) as T;
    }
    const factory = this.factories.get(token);
    if (!factory) throw new Error(`Unknown service: ${token.toString()}`);
    return factory() as T;
  }

  has(token: symbol): boolean {
    return this.factories.has(token);
  }
}

export function createToken<T>(name: string): symbol {
  return Symbol.for(`tern:${name}`);
}
