// src/__tests__/harness.test.tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { WebView } from 'react-native-webview';

test('the mock WebView renders and delivers a message event', async () => {
  const onMessage = jest.fn();
  await render(<WebView source={{ uri: 'https://x/y' }} onMessage={onMessage} testID="wv" />);
  await fireEvent(screen.getByTestId('wv'), 'message', { nativeEvent: { data: '{"ok":true}' } });
  expect(onMessage).toHaveBeenCalled();
});
