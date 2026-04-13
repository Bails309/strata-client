import '@testing-library/jest-dom/vitest';
import { vi, afterEach } from 'vitest';

// Mock window.matchMedia for jsdom (not implemented)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: query === '(prefers-color-scheme: dark)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// Increase timeout for slow CI environments
vi.setConfig({ testTimeout: 15000 });
