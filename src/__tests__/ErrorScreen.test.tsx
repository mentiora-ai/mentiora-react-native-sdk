import { fireEvent, render, screen } from '@testing-library/react-native';
import { ErrorScreen } from '../ui/ErrorScreen';
import { DEFAULT_STRINGS } from '../ui/strings';

test('renders a retry and a dismiss, both reachable to a screen reader', async () => {
  const onRetry = jest.fn(),
    onDismiss = jest.fn();
  await render(<ErrorScreen code="load_failed" onRetry={onRetry} onDismiss={onDismiss} />);
  const retry = screen.getByRole('button', { name: DEFAULT_STRINGS.retry });
  const dismiss = screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss });
  await fireEvent.press(retry);
  await fireEvent.press(dismiss);
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('a partial strings override replaces only what it names', async () => {
  await render(
    <ErrorScreen
      code="load_failed"
      onRetry={jest.fn()}
      onDismiss={jest.fn()}
      strings={{ retry: 'Nochmal' }}
    />,
  );
  // getByRole, not getByText: a dropped accessibilityLabel still renders the text.
  expect(screen.getByRole('button', { name: 'Nochmal' })).toBeTruthy();
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss })).toBeTruthy();
});

test('an explicit undefined in strings falls back to the default, not a blank control', async () => {
  await render(
    <ErrorScreen
      code="load_failed"
      onRetry={jest.fn()}
      onDismiss={jest.fn()}
      strings={{ retry: undefined }}
    />,
  );
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.retry })).toBeTruthy();
});

test('an override alongside an undefined applies the override and falls back for the undefined key', async () => {
  await render(
    <ErrorScreen
      code="load_failed"
      onRetry={jest.fn()}
      onDismiss={jest.fn()}
      strings={{ retry: 'Nochmal', dismiss: undefined }}
    />,
  );
  expect(screen.getByRole('button', { name: 'Nochmal' })).toBeTruthy();
  expect(screen.getByRole('button', { name: DEFAULT_STRINGS.dismiss })).toBeTruthy();
});

test('every code renders the same sentence — the code is for onEvent, not for the user', async () => {
  for (const code of ['load_failed', 'handshake_timeout', 'renderer_crashed'] as const) {
    const view = await render(
      <ErrorScreen code={code} onRetry={jest.fn()} onDismiss={jest.fn()} />,
    );
    expect(screen.getByText(DEFAULT_STRINGS.errorBody)).toBeTruthy();
    // Presence alone would pass while <Text>{code}</Text> leaks the code to the user.
    expect(screen.queryByText(code)).toBeNull();
    await view.unmount();
  }
});
