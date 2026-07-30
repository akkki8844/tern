
import { getLogger } from "./logger";
const logger = getLogger("metrics");

export interface Metric {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: Date;
}

export class MetricsCollector {
  private metrics: Metric[] = [];
  private maxSize = 10000;
  record(name: string, value: number, labels: Record<string, string> = {}): void {
    if (this.metrics.length >= this.maxSize) this.metrics.shift();
    this.metrics.push({ name, value, labels, timestamp: new Date() });
    logger.debug("metric recorded", { metric: name, value, labels });
  }
  query(name: string, labels?: Record<string, string>): Metric[] {
    return this.metrics.filter(m => {
      if (m.name !== name) return false;
      if (!labels) return true;
      return Object.entries(labels).every(([k, v]) => m.labels[k] === v);
    });
  }
  all(): Metric[] { return [...this.metrics]; }
  count(name: string): number { return this.metrics.filter(m => m.name === name).length; }
  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of this.metrics) {
      out[m.name] = (out[m.name] || 0) + m.value;
    }
    return out;
  }
}
