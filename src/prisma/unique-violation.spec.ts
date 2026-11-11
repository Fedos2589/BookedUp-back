import { Prisma } from '../generated/prisma/client.js';
import { violatedExclusion } from './unique-violation.js';

// What the pg adapter of Prisma 7 throws on an exclusion violation (probed on the real database),
// with the message in the language of the server's lc_messages.
const exclusionError = (message: string, code = '23P01') =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code: 'P2039',
    clientVersion: '7.10.1',
    meta: { modelName: 'OneOffWindow', driverAdapterError: { name: 'DriverAdapterError', cause: { code, message } } },
  });

describe('violatedExclusion', () => {
  it('names the table whose exclusion constraint refused the row', () => {
    const english = 'conflicting key value violates exclusion constraint "one_off_windows_no_overlap"';
    expect(violatedExclusion(exclusionError(english))).toBe('OneOffWindow');
  });

  it('does not depend on the language of the server messages', () => {
    const russian = 'конфликтующее значение ключа нарушает ограничение-исключение «one_off_windows_no_overlap»';
    expect(violatedExclusion(exclusionError(russian))).toBe('OneOffWindow');
  });

  it('is undefined for another database error, or not a database error', () => {
    expect(violatedExclusion(exclusionError('duplicate key value', '23505'))).toBeUndefined();
    expect(violatedExclusion(new Error('23P01'))).toBeUndefined();
    const lookalike = { meta: { ...exclusionError('x').meta } };
    expect(violatedExclusion(lookalike)).toBeUndefined();
  });
});
