import { ConfigService } from '@nestjs/config';
import { sendNotification, setVapidDetails } from 'web-push';

import { PushChannel } from './push.channel.js';

vi.mock('web-push', () => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
  WebPushError: class WebPushError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
    }
  },
}));

const channel = () =>
  new PushChannel(
    new ConfigService({
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'mailto:ops@example.com',
    }),
  );
const keys = { p256dh: 'p256', auth: 'auth' };
const message = { subject: 'Booked', text: 'Booked: Fri 27 Nov', url: 'https://app.example.com/book/studio' };

const failure = async (statusCode: number) => {
  const { WebPushError } = await import('web-push');
  return new WebPushError('push failed', statusCode, {}, '', 'https://push.example/x');
};

describe('PushChannel', () => {
  afterEach(() => vi.clearAllMocks());

  it('pushes title, body and url to the subscription, kept for a day', async () => {
    vi.mocked(sendNotification).mockResolvedValue({ statusCode: 201, body: '', headers: {} });

    const result = await channel().send('https://push.example/abc', message, keys);

    expect(result).toBe('sent');
    expect(setVapidDetails).toHaveBeenCalledWith('mailto:ops@example.com', 'pub', 'priv');
    const [subscription, payload, options] = vi.mocked(sendNotification).mock.calls[0]!;
    expect(subscription).toEqual({ endpoint: 'https://push.example/abc', keys });
    expect(JSON.parse(payload as string)).toEqual({
      title: 'Booked',
      body: 'Booked: Fri 27 Nov',
      url: 'https://app.example.com/book/studio',
    });
    expect(options).toMatchObject({ TTL: 86_400 });
  });

  it('404 and 410 (the subscription is gone) → unreachable', async () => {
    for (const status of [404, 410]) {
      vi.mocked(sendNotification).mockRejectedValueOnce(await failure(status));
      expect(await channel().send('https://push.example/abc', message, keys)).toBe('unreachable');
    }
  });

  it('500 → throws, so the delivery is tried again', async () => {
    vi.mocked(sendNotification).mockRejectedValueOnce(await failure(500));
    await expect(channel().send('https://push.example/abc', message, keys)).rejects.toThrow();
  });

  it('a delivery without keys is a bug in the caller, not a switched-off channel', async () => {
    await expect(channel().send('https://push.example/abc', message)).rejects.toThrow(/keys/);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
