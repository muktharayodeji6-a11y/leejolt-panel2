export default {
  async fetch(request, env) {
    return new Response(JSON.stringify({ message: "Worker is alive" }), {
      headers: { "Content-Type": "application/json" },
    });
  },
  async scheduled(event, env, ctx) {
    console.log("Scheduled run triggered");
  },
};
