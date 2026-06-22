export default function AIAssistant() {
    return (
      <div className="p-6">
        <h1 className="text-3xl font-bold mb-2">
          AI Assistant
        </h1>
  
        <p className="text-gray-400 mb-6">
          Manage messenger automation
        </p>
  
        <div className="grid gap-4 md:grid-cols-3">
          <div className="bg-slate-800 rounded-xl p-4">
            <h2 className="text-xl font-semibold">
              Telegram
            </h2>
  
            <p className="text-gray-400 mt-2">
              Status: Not connected
            </p>
  
            <button className="mt-4 px-4 py-2 bg-purple-600 rounded-lg">
              Connect Telegram
            </button>
          </div>
  
          <div className="bg-slate-800 rounded-xl p-4">
            <h2 className="text-xl font-semibold">
              WhatsApp
            </h2>
  
            <p className="text-gray-400 mt-2">
              Status: Not connected
            </p>
          </div>
  
          <div className="bg-slate-800 rounded-xl p-4">
            <h2 className="text-xl font-semibold">
              Instagram
            </h2>
  
            <p className="text-gray-400 mt-2">
              Status: Not connected
            </p>
          </div>
        </div>
      </div>
    );
  }