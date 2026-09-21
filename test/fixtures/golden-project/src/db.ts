export function query(sql: string): unknown[] {
  return [];
}

export function insert(table: string, data: Record<string, unknown>): boolean {
  return true;
}

export function migrate(): void {}
