import { describe, expect, it } from 'vitest';
import { cronExpressionProblem } from '../../src/cron';

/**
 * FR-5.4 — the cron grammar a scheduled workflow is compiled from.
 *
 * `61 * * * *` used to save, validate clean and fail at activation with n8n's bare `400`, reported
 * as an adapter outage. These cases are the field grammar: what the engine reads, and what it does
 * not — each refusal naming the field so the author does not have to guess which of five numbers is
 * wrong.
 */
describe('cronExpressionProblem', () => {
  it.each([
    '0 2 * * *',
    '*/15 * * * *',
    '30 5 * * 1-5',
    '0 0 1 JAN,JUL *',
    '0 9 * * MON-FRI',
    '5,10,15 * * * *',
    '0 0 * * 7',
    '  0  2  *  *  *  ',
  ])('accepts %s', (expression) => {
    expect(cronExpressionProblem(expression)).toBeNull();
  });

  it('refuses a field count the compiler cannot read', () => {
    // The message names the count: "invalid" leaves the author counting characters.
    expect(cronExpressionProblem('0 2 * *')).toContain('five fields');
    expect(cronExpressionProblem('0 2 * * * *')).toContain('and this has 6');
  });

  it('refuses a value outside its field', () => {
    // The live failure: an impossible minute passed every check the platform had.
    expect(cronExpressionProblem('61 * * * *')).toContain(
      'Minute "61" is not a number from 0 to 59',
    );
    expect(cronExpressionProblem('0 24 * * *')).toContain('Hour "24"');
    expect(cronExpressionProblem('0 0 32 * *')).toContain('Day of month "32"');
    expect(cronExpressionProblem('0 0 * 13 *')).toContain('Month "13"');
    expect(cronExpressionProblem('0 0 * * 8')).toContain('Day of week "8"');
    // Day of month starts at 1: `0` is a value no calendar has.
    expect(cronExpressionProblem('0 0 0 * *')).toContain('Day of month "0"');
  });

  it('refuses a backwards range and a step below one', () => {
    expect(cronExpressionProblem('0 0 * * 5-1')).toContain('runs backwards');
    expect(cronExpressionProblem('*/0 * * * *')).toContain('step of at least 1');
    expect(cronExpressionProblem('*/x * * * *')).toContain('step of at least 1');
    // The far end of a range is checked like a value: "1-99" is one bad number, not a bad range.
    expect(cronExpressionProblem('0 0 * * 1-99')).toContain('Day of week "99"');
  });

  it('names the field and offers the accepted values', () => {
    const problem = cronExpressionProblem('0 0 * FOO *');
    expect(problem).toContain('Month "FOO"');
    expect(problem).toContain('JAN');
  });

  it('refuses the shapes a reader might invent', () => {
    expect(cronExpressionProblem('0 2 * * * *')).toContain('five fields');
    expect(cronExpressionProblem('every day')).toContain('five fields');
    expect(cronExpressionProblem('1,,2 * * * *')).toContain('empty list item');
    expect(cronExpressionProblem('1/2/3 * * * *')).toContain('more than one "/"');
    expect(cronExpressionProblem('* * * * 1-2-3')).toContain('more than one "-"');
  });
});
