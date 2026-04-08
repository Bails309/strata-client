import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from '../components/ThemeProvider';

// Helper component that exposes theme context values
function ThemeConsumer() {
  const { theme, preference, setPreference, cycle } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="preference">{preference}</span>
      <button data-testid="cycle" onClick={cycle}>Cycle</button>
      <button data-testid="set-dark" onClick={() => setPreference('dark')}>Dark</button>
      <button data-testid="set-light" onClick={() => setPreference('light')}>Light</button>
      <button data-testid="set-system" onClick={() => setPreference('system')}>System</button>
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark', 'light');
  });

  it('defaults to system preference', () => {
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference').textContent).toBe('system');
  });

  it('applies saved preference from localStorage', () => {
    localStorage.setItem('strata-theme-preference', 'dark');
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference').textContent).toBe('dark');
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('setPreference updates theme and persists', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    await user.click(screen.getByTestId('set-dark'));
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(screen.getByTestId('preference').textContent).toBe('dark');
    expect(localStorage.getItem('strata-theme-preference')).toBe('dark');
  });

  it('cycle rotates through system → light → dark', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );

    // Default is system
    expect(screen.getByTestId('preference').textContent).toBe('system');

    await user.click(screen.getByTestId('cycle'));
    expect(screen.getByTestId('preference').textContent).toBe('light');

    await user.click(screen.getByTestId('cycle'));
    expect(screen.getByTestId('preference').textContent).toBe('dark');

    await user.click(screen.getByTestId('cycle'));
    expect(screen.getByTestId('preference').textContent).toBe('system');
  });

  it('adds theme class to document element', () => {
    localStorage.setItem('strata-theme-preference', 'light');
    render(
      <ThemeProvider>
        <ThemeConsumer />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });
});

describe('useTheme', () => {
  it('throws when used outside ThemeProvider', () => {
    // Suppress console.error for this test
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ThemeConsumer />)).toThrow(
      'useTheme must be used within <ThemeProvider>',
    );
    spy.mockRestore();
  });
});
