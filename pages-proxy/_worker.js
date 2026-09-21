export default {
  async fetch(request, env) {
    return env.BACKEND.fetch(request);
  },
};
