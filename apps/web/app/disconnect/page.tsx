
export default function DisconnectPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Disconnect</h1>
      <p className="mt-4 text-neutral-400">Remove the Tern GitHub App from your account. This will stop all analyses and revoke access.</p>
      <button className="mt-6 rounded-md border border-red-800 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-950/30 transition">Disconnect Account</button>
    </div>
  );
}
