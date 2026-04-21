import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Select from '../components/Select';

const OPTIONS = [
  { value: 'rdp', label: 'RDP' },
  { value: 'ssh', label: 'SSH' },
  { value: 'vnc', label: 'VNC' },
];

describe('Select', () => {
  it('renders with placeholder when no value selected', () => {
    render(<Select value="" onChange={vi.fn()} options={OPTIONS} placeholder="Choose..." />);
    expect(screen.getByText('Choose...')).toBeInTheDocument();
  });

  it('renders selected option label', () => {
    render(<Select value="ssh" onChange={vi.fn()} options={OPTIONS} />);
    expect(screen.getByText('SSH')).toBeInTheDocument();
  });

  it('opens dropdown on click and shows all options', async () => {
    const user = userEvent.setup();
    render(<Select value="" onChange={vi.fn()} options={OPTIONS} placeholder="Pick" />);

    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('calls onChange when an option is clicked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Select value="" onChange={onChange} options={OPTIONS} />);

    await user.click(screen.getByRole('button'));
    await user.click(screen.getByText('VNC'));
    expect(onChange).toHaveBeenCalledWith('vnc');
  });

  it('closes dropdown after selection', async () => {
    const user = userEvent.setup();
    render(<Select value="" onChange={vi.fn()} options={OPTIONS} />);

    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.click(screen.getByText('RDP'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('default placeholder when none provided', () => {
    render(<Select value="" onChange={vi.fn()} options={OPTIONS} />);
    expect(screen.getByText('Select…')).toBeInTheDocument();
  });

  it('sets aria-expanded correctly', async () => {
    const user = userEvent.setup();
    render(<Select value="" onChange={vi.fn()} options={OPTIONS} />);
    const btn = screen.getByRole('button');

    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await user.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('marks selected option with aria-selected', async () => {
    const user = userEvent.setup();
    render(<Select value="ssh" onChange={vi.fn()} options={OPTIONS} />);

    await user.click(screen.getByRole('button'));
    const options = screen.getAllByRole('option');
    const sshOption = options.find((o) => o.textContent?.includes('SSH'));
    expect(sshOption).toHaveAttribute('aria-selected', 'true');
  });

  // ── searchable mode branch coverage ──
  it('renders search input when searchable and open', async () => {
    const user = userEvent.setup();
    render(<Select value="" onChange={vi.fn()} options={OPTIONS} searchable />);
    await user.click(screen.getByRole('button'));
    expect(screen.getByPlaceholderText('Filter options...')).toBeInTheDocument();
  });

  it('filters options by search query', async () => {
    const user = userEvent.setup();
    render(<Select value="" onChange={vi.fn()} options={OPTIONS} searchable />);
    await user.click(screen.getByRole('button'));
    const input = screen.getByPlaceholderText('Filter options...');
    await user.type(input, 'ss');
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(1);
    expect(opts[0]).toHaveTextContent('SSH');
  });

  it('clear button resets the search query', async () => {
    const user = userEvent.setup();
    render(<Select value="" onChange={vi.fn()} options={OPTIONS} searchable />);
    await user.click(screen.getByRole('button'));
    const input = screen.getByPlaceholderText('Filter options...') as HTMLInputElement;
    await user.type(input, 'rdp');
    const clearBtn = screen.getByText('✕').closest('button')!;
    await user.click(clearBtn);
    expect(input.value).toBe('');
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('does not close menu on Enter inside search input', async () => {
    const user = userEvent.setup();
    render(<Select value="" onChange={vi.fn()} options={OPTIONS} searchable />);
    await user.click(screen.getByRole('button'));
    const input = screen.getByPlaceholderText('Filter options...');
    await user.type(input, '{Enter}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});
