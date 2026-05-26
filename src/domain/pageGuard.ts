export class PageGuard {
  constructor(
    private readonly limit: number,
    private usedPages: number
  ) {}

  get used(): number {
    return this.usedPages;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.usedPages);
  }

  canSpend(pages: number): boolean {
    return this.usedPages + Math.max(0, pages) <= this.limit;
  }

  spend(pages: number): void {
    const normalized = Math.max(0, pages);
    if (!this.canSpend(normalized)) {
      throw new Error(`Page limit exceeded: used=${this.usedPages}, next=${normalized}, limit=${this.limit}`);
    }
    this.usedPages += normalized;
  }

  refund(pages: number): void {
    this.usedPages = Math.max(0, this.usedPages - Math.max(0, pages));
  }
}
