// Authentication is refreshed only when needed, through the official launcher API.
export function passwordConnector({ credentials, initialSession, login, connect, signal, log }) {
  let session = initialSession;
  return async () => {
    try {
      if (!session) session = await login(credentials.username, credentials.password, credentials.authOrigin, signal);
      const result = await connect(session);
      if (['AUTH_REJECTED','SERVER_SESSION_EXPIRED'].includes(result.error?.code)) {
        // A restarting backend can reject even a fresh session. Refresh again on
        // the next scheduled attempt; never turn a second rejection into a stop.
        session = undefined;
        log.event('session_refresh_scheduled');
        return { ...result, error:{ code:'SESSION_REFRESH', retryable:true } };
      }
      return result;
    } catch (error) {
      if (!error.code?.startsWith('LOGIN_')) throw error;
      // Downtime can last hours. Invalid credentials and extra verification remain terminal.
      const unavailable = ['LOGIN_NETWORK','LOGIN_TIMEOUT','LOGIN_SERVICE_ERROR'].includes(error.code);
      return { error:{ code:error.code || 'INTERNAL', retryable:unavailable }, serverUnavailable:unavailable, stableMs:0 };
    }
  };
}
