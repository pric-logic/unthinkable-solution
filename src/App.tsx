import React, { useEffect, useMemo, useRef, useState } from "react";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Vite exposes env vars via import.meta.env and typically prefixed with VITE_
const API_KEY = (((import.meta as any).env?.VITE_GEMINI_API_KEY) as string) || "";
const genAI = new GoogleGenerativeAI(API_KEY);

type ChatMessage = {
  role: "user" | "model";
  content: string;
};

type Intent =
  | { type: "order_status"; orderId?: string }
  | { type: "shipping_eta"; orderId?: string; postalCode?: string }
  | { type: "return_policy" }
  | { type: "refund_policy" }
  | { type: "account_help" }
  | { type: "escalate" }
  | { type: "unknown" };

type ToolResult = {
  title: string;
  body: string;
};

const SUPPORT_SYSTEM_PROMPT = `You are a helpful, empathetic customer support assistant for ACME Store.
Policies:
- Greet warmly, be concise, and ask clarifying questions when needed.
- Never invent order data; if unknown, ask for order ID or email.
- Provide step-by-step troubleshooting for common issues (orders, returns, refunds, shipping, account, payments).
- Offer to escalate to a human agent when issues are sensitive or unresolved.
- Keep answers under 6 sentences unless the user asks for more detail.`;

const CustomerSupportBot: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "model", content: "Hi! I’m your ACME support assistant. How can I help today?" },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>(["Where is my order?", "What’s your return policy?", "Talk to a human"]);
  const lastIntentRef = useRef<Intent>({ type: "unknown" });
  const [streamingIndex, setStreamingIndex] = useState<number | null>(null);
  const streamingTimerRef = useRef<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(true);

  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [messages]);

  const model = useMemo(() => genAI.getGenerativeModel({ model: "gemini-pro" }), []);

  // --- Intent detection (heuristic) ---
  const detectIntent = (text: string): Intent => {
    const t = text.toLowerCase();
    const idMatch = t.match(/#?(?:order|ord)\s*([a-z0-9-]{5,})/i);
    const zipMatch = t.match(/\b(\d{5})(?:-\d{4})?\b/);

    if (/(where|status|track).*(order|package)/.test(t)) {
      return { type: "order_status", orderId: idMatch?.[1] };
    }
    if (/(when|arrive|coming|eta|delivery).*(order|package|shipping)/.test(t)) {
      return { type: "shipping_eta", orderId: idMatch?.[1], postalCode: zipMatch?.[1] };
    }
    if (/(return|exchange).*(policy|how|can i)/.test(t)) return { type: "return_policy" };
    if (/(refund).*(policy|how|timeline)/.test(t)) return { type: "refund_policy" };
    if (/(login|account|password|profile|email change)/.test(t)) return { type: "account_help" };
    if (/(human|agent|representative|someone|escalate)/.test(t)) return { type: "escalate" };
    return { type: "unknown" };
  };

  // --- Smart tools (mocked) ---
  const toolOrderStatus = async (orderId?: string): Promise<ToolResult> => {
    if (!orderId) {
      return { title: "Order status", body: "I can check that—please share your order ID (e.g., ORD-12345)." };
    }
    // Mocked status
    const statusList = ["Processing", "Packed", "Shipped", "Out for delivery", "Delivered"];
    const status = statusList[Math.floor(Math.random() * statusList.length)];
    return {
      title: "Order status",
      body: `Order ${orderId} is currently: ${status}. If this seems wrong, I can escalate to a human.`,
    };
  };

  const toolShippingEta = async (orderId?: string, postalCode?: string): Promise<ToolResult> => {
    if (!orderId || !postalCode) {
      return { title: "Shipping ETA", body: "Share your order ID and destination ZIP to estimate delivery." };
    }
    const days = 2 + Math.floor(Math.random() * 4);
    const etaDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toDateString();
    return { title: "Shipping ETA", body: `Estimated delivery for ${orderId} to ${postalCode}: ${etaDate}.` };
  };

  const toolReturnPolicy = async (): Promise<ToolResult> => ({
    title: "Return policy",
    body: "You can return most items within 30 days in original condition. Start in My Orders > Return. Prepaid label provided in eligible regions.",
  });

  const toolRefundPolicy = async (): Promise<ToolResult> => ({
    title: "Refund policy",
    body: "Refunds are issued to the original payment method within 5–7 business days after we receive your return.",
  });

  const toolAccountHelp = async (): Promise<ToolResult> => ({
    title: "Account help",
    body: "For password resets, use Forgot Password on the sign-in page. For email or profile changes, go to Account Settings.",
  });

  const runToolForIntent = async (intent: Intent): Promise<ToolResult | null> => {
    switch (intent.type) {
      case "order_status":
        return toolOrderStatus(intent.orderId);
      case "shipping_eta":
        return toolShippingEta(intent.orderId, intent.postalCode);
      case "return_policy":
        return toolReturnPolicy();
      case "refund_policy":
        return toolRefundPolicy();
      case "account_help":
        return toolAccountHelp();
      case "escalate":
        return { title: "Escalation", body: "I can connect you with a human agent. Please confirm: type 'yes' to proceed or ask anything else to continue with me." };
      default:
        return null;
    }
  };

  // --- Sentiment detection (very simple heuristic) ---
  const analyzeSentiment = (text: string): "positive" | "neutral" | "negative" => {
    const t = text.toLowerCase();
    const neg = /(angry|upset|frustrated|bad|hate|terrible|worst|unacceptable|late|delay|broken|missing)/.test(t);
    const pos = /(great|thanks|thank you|awesome|perfect|good|love)/.test(t);
    if (neg && !pos) return "negative";
    if (pos && !neg) return "positive";
    return "neutral";
  };

  const applyTone = (reply: string, userText: string): string => {
    const sentiment = analyzeSentiment(userText);
    if (sentiment === "negative") {
      return `I’m really sorry for the trouble. ${reply}`;
    }
    if (sentiment === "positive") {
      return `Happy to hear that! ${reply}`;
    }
    return reply;
  };

  // --- Streaming typing effect ---
  const streamModelReply = (fullText: string) => {
    // Push an empty model message and then append characters
    setMessages((prev: ChatMessage[]) => [...prev, { role: "model", content: "" }]);
    const startIndex = messages.length; // index where the empty message will appear after state batches
    setStreamingIndex(startIndex);

    let i = 0;
    const step = () => {
      setMessages((prev: ChatMessage[]) => {
        const copy = [...prev];
        const at = Math.min(startIndex, copy.length - 1);
        const current = copy[at];
        if (!current || current.role !== "model") return prev;
        copy[at] = { role: "model", content: fullText.slice(0, i) };
        return copy;
      });
      i += Math.max(1, Math.floor(fullText.length / 120));
      if (i <= fullText.length) {
        streamingTimerRef.current = window.setTimeout(step, 16);
      } else {
        setStreamingIndex(null);
      }
    };
    step();
  };

  const handleSend = async (): Promise<void> => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setLoading(true);

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    setInput("");

    try {
      // Escalation confirmation path
      if (lastIntentRef.current.type === "escalate" && /^(yes|yep|yeah|confirm|please)\b/i.test(trimmed)) {
        const ticketId = Math.random().toString(36).slice(2, 8).toUpperCase();
        const reply = `Okay, connecting you to a human agent. I created support ticket #${ticketId}. An agent will reach out by email shortly.`;
        streamModelReply(applyTone(reply, trimmed));
        setSuggestions(["Add more details", "Update my email", "Anything else?"]);
        setLoading(false);
        return;
      }

      // Try smart tool first
      const intent = detectIntent(trimmed);
      lastIntentRef.current = intent;
      const toolResult = await runToolForIntent(intent);

      if (toolResult) {
        const replyWithTone = applyTone(`${toolResult.title}:\n${toolResult.body}`, trimmed);
        streamModelReply(replyWithTone);
        // Update suggestions based on intent
        switch (intent.type) {
          case "order_status":
            setSuggestions(["Track shipping ETA", "This seems wrong → escalate", "Anything else?"]);
            break;
          case "shipping_eta":
            setSuggestions(["Remind me if delayed", "Change delivery address", "Talk to a human"]);
            break;
          case "return_policy":
            setSuggestions(["Start a return", "Refund timeline", "Anything else?"]);
            break;
          case "refund_policy":
            setSuggestions(["Check return status", "Payment method changes", "Talk to a human"]);
            break;
          case "account_help":
            setSuggestions(["Reset password", "Change email", "Close account"]);
            break;
          case "escalate":
            setSuggestions(["Yes, connect me", "No, continue here", "Anything else?"]);
            break;
          default:
            setSuggestions(["Where is my order?", "What’s your return policy?", "Talk to a human"]);
        }
        setLoading(false);
        return;
      }

      // Build a simple chat history with a system-style preface
      const historyText = [SUPPORT_SYSTEM_PROMPT]
        .concat(nextMessages.map((m: ChatMessage) => (m.role === "user" ? `User: ${m.content}` : `Assistant: ${m.content}`)))
        .join("\n\n");

      const result = await model.generateContent(historyText);
      const reply = applyTone(result.response.text(), trimmed);
      streamModelReply(reply);
      // Generic suggestions after model reply
      setSuggestions(["Track an order", "Returns & refunds", "Talk to a human"]);
    } catch (err: unknown) {
      setMessages((prev: ChatMessage[]) => [
        ...prev,
        { role: "model", content: "Sorry, I ran into a problem generating a response. Please try again." },
      ]);
    } finally {
      setLoading(false);
    }
  };

  // Help panel content derived from last intent
  const helpItems: { title: string; content: string }[] = (() => {
    const intent = lastIntentRef.current;
    switch (intent.type) {
      case "order_status":
        return [
          { title: "Find your order ID", content: "Check your confirmation email or My Orders page." },
          { title: "Tracking not updating", content: "Carriers may take 24–48h to refresh scans." },
        ];
      case "shipping_eta":
        return [
          { title: "ETA basics", content: "ETAs are estimates; weather and customs can add delays." },
          { title: "Signature required", content: "Some high-value orders require a signature on delivery." },
        ];
      case "return_policy":
        return [
          { title: "Return window", content: "30 days from delivery for most items." },
          { title: "Exceptions", content: "Final-sale and perishable goods are not returnable." },
        ];
      case "refund_policy":
        return [
          { title: "Refund timeline", content: "5–7 business days after we receive your return." },
          { title: "Store credit", content: "Choose instant store credit at return start for faster repurchase." },
        ];
      case "account_help":
        return [
          { title: "Reset password", content: "Use Forgot Password; check spam if email doesn't arrive." },
          { title: "Change email", content: "Update in Account Settings > Security." },
        ];
      default:
        return [
          { title: "Popular topics", content: "Order tracking, returns, refunds, and account help." },
          { title: "Contact us", content: "If you need a human, say 'talk to a human'." },
        ];
    }
  })();

  const handleKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat">
      <h1 className="chat__title">Customer Support Bot</h1>

      <div className="chat__viewport" ref={viewportRef}>
        {messages.map((m, idx) => (
          <div key={idx} className={`message ${m.role === "user" ? "message--user" : "message--bot"}`}>
            <div className="message__bubble">{m.content}</div>
          </div>
        ))}
        {loading && (
          <div className="message message--bot"><div className="message__bubble">Typing…</div></div>
        )}
      </div>

      <div className="help-panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 className="help-panel__title">Helpful info</h3>
          <button className="chip" onClick={() => setHelpOpen(!helpOpen)}>{helpOpen ? "Hide" : "Show"}</button>
        </div>
        {helpOpen && helpItems.map((h, i) => (
          <div key={i} className="help-item">
            <div className="help-item__title">{h.title}</div>
            <div className="help-item__content">{h.content}</div>
          </div>
        ))}
      </div>

      <div className="suggestions">
        {suggestions.map((s, i) => (
          <button key={i} className="chip" onClick={() => setInput(s)}>{s}</button>
        ))}
      </div>

      <div className="input-row">
        <input
          className="input-row__input"
          type="text"
          placeholder="Type your message…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button className="input-row__button" onClick={handleSend} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>

      {API_KEY ? null : (
        <p className="env-warning">No API key found. Set VITE_GEMINI_API_KEY in your environment.</p>
      )}
    </div>
  );
};

export default CustomerSupportBot;
 