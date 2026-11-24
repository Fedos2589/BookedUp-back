import { Logger } from '@nestjs/common';

import { LogChannel } from './log.channel.js';
import { renderInput } from './render-input.fixture.js';

describe('LogChannel', () => {
  it('writes the message to the log without a link in it, and masks the address', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const result = await new LogChannel().send(
      '+79991234567',
      renderInput({ manageLink: 'https://app.example.com/booking/abc123?x=1' }),
    );

    expect(result).toBe('sent');
    expect(log).toHaveBeenCalledOnce();
    const entry = JSON.stringify(log.mock.calls[0]);
    expect(entry).toContain('Studio');
    expect(entry).not.toContain('abc123');
    expect(entry).not.toContain('+79991234567');
    expect(entry).toContain('4567');
    log.mockRestore();
  });
});
