import { CopilotKitProvider, CopilotChat } from "@copilotkit/react-core/v2";

export default function App() {
  return (
    /* [!code highlight:5] */
    <CopilotKitProvider runtimeUrl="http://localhost:8200/api/copilotkit">
      <div style={{ height: "100vh" }}>
        <CopilotChat />
      </div>
    </CopilotKitProvider>
  );
}
