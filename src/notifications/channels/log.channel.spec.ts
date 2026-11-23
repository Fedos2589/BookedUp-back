import { Logger } from '@nestjs/common';

import { LogChannel } from './log.channel.js';

describe('LogChannel', () => {
  it('writes the message to the log without a link in it, and masks the address', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const result = await new LogChannel().send('+79991234567', {
      subject: 'Booked',
      text: 'Booked: Fri 27 Nov\nManage: https://app.example.com/booking/abc123?x=1 — here',
    });

    expect(result).toBe('sent');
    expect(log).toHaveBeenCalledOnce();
    const entry = JSON.stringify(log.mock.calls[0]);
    expect(entry).toContain('Booked: Fri 27 Nov');
    expect(entry).not.toContain('abc123');
    expect(entry).not.toContain('+79991234567');
    expect(entry).toContain('4567');
    log.mockRestore();
  });
});
