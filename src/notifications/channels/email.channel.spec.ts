import type { Mailer } from '../../mail/mailer.js';
import { messageFor } from '../messages.js';
import { EmailChannel } from './email.channel.js';
import { renderInput } from './render-input.fixture.js';

describe('EmailChannel', () => {
  it('renders the message and hands it to the Mailer, returning its result', async () => {
    const send = vi.fn().mockResolvedValue('unreachable');
    const input = renderInput({ locale: 'ru' });

    const result = await new EmailChannel({ send } as unknown as Mailer).send('anna@example.com', input);

    expect(result).toBe('unreachable');
    const { subject, text } = messageFor(input);
    expect(send).toHaveBeenCalledWith({ to: 'anna@example.com', subject, text });
  });
});
