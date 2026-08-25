import { Logger, ServiceUnavailableException } from '@nestjs/common';

import { AllExceptionsFilter } from './all-exceptions.filter';

describe('all exceptions filter health logging', () => {
  afterEach(() => jest.restoreAllMocks());

  it('warns without an unhandled-exception stack for a failed probe', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const send = jest.fn();
    const reply = {
      status: jest.fn().mockReturnThis(),
      header: jest.fn().mockReturnThis(),
      send,
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({ url: '/health/ready' }),
      }),
    } as never;
    const exception = new ServiceUnavailableException({
      status: 'error',
      error: { database: { status: 'down' } },
      details: { database: { status: 'down' } },
    });

    new AllExceptionsFilter().catch(exception, host);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/health/ready' }),
      'Health check failed: database',
    );
    expect(error).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 503,
        checks: { database: { status: 'down' } },
      }),
    );
  });
});
