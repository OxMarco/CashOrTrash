import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

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

  /**
   * The contract the app switches on. A refusal thrown with `{ error, message }`
   * has to keep the slug in `type` and the prose in `title`: the client picks
   * its own sentence from the first and never reads the second, so a reworded
   * message must not move the slug — and this is what says so.
   */
  it('keeps a thrown slug in `type` and its prose in `title`', () => {
    const send = jest.fn();
    const reply = {
      status: jest.fn().mockReturnThis(),
      header: jest.fn().mockReturnThis(),
      send,
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({ url: '/v1/sessions/x/rounds/0/bet' }),
      }),
    } as never;

    new AllExceptionsFilter().catch(
      new BadRequestException({
        error: 'round-too-fast',
        message: 'Take a moment to look at the item',
      }),
      host,
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'round-too-fast',
        title: 'Take a moment to look at the item',
        status: 400,
      }),
    );
  });
});
