using System.Security.Cryptography;
using System;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEngine;

public class TcpClientUnity : MonoBehaviour
{
    static string ComputeSha256(string secretKey, string input)
    {
        using (SHA256 sha256 = SHA256.Create())
        {
            byte[] bytes = Encoding.UTF8.GetBytes(secretKey + input);
            byte[] hash = sha256.ComputeHash(bytes);

            // Convert to hex string
            StringBuilder sb = new StringBuilder();
            foreach (byte b in hash)
                sb.Append(b.ToString("x2"));

            return sb.ToString();
        }
    }

    public string serverIP = "192.168.1.199";
    public string[] serverIPs;
    public int portNumber = 5000;

    public string secretKey = "";

    public string plazaID = "P01";
    public string laneID = "L01";
    public string laneType = "3"; // 1 Entry, 2 Exit, 3 Open, 4 Dual
    public string operationMode = "1"; // 0 Maintenance, 1 Live, 2 Not In Use

    private TcpClient client;
    private NetworkStream stream;
    private Thread receiveThread;

    [SerializeField] private volatile bool isRunning = false;

    void Start()
    {

    }

    // ===================== CONNECT =====================
    public void ConnectToServer()
    {
        if (client != null && client.Connected)
        {
            Debug.Log("Already connected");
            return;
        }

        try
        {
            client = new TcpClient();
            client.Connect(serverIP, portNumber);

            stream = client.GetStream();
            isRunning = true;

            receiveThread = new Thread(ReceiveData);
            receiveThread.IsBackground = true;
            receiveThread.Start();

            Debug.Log("Connected to TCP server");

            // InitTerminal();
        }
        catch (Exception e)
        {
            Debug.LogError("TCP connection error: " + e.Message);
            Disconnect();
        }
    }

    // ===================== RECEIVE =====================
    void ReceiveData()
    {
        byte[] buffer = new byte[2048];

        while (isRunning && client != null && client.Connected)
        {
            try
            {
                int length = stream.Read(buffer, 0, buffer.Length);
                if (length <= 0) continue;

                string receivedMessage = Encoding.UTF8.GetString(buffer, 0, length);
                HandleIncomingMessage(receivedMessage);
            }
            catch (Exception e)
            {
                Debug.Log("Receive thread stopped: " + e.Message);
                break;
            }
        }
    }

    private void HandleIncomingMessage(string json)
    {
        Debug.Log("Received: " + json);
        string message = ExtractJsonValue(json, "message");
        if (string.IsNullOrEmpty(message))
            return;

        switch (message)
        {
            case "initEntryStatus":
                AckStatus(json, "initEntryStatus");
                HandleInitEntryStatus(json);
                break;
            case "initExitStatus":
                AckStatus(json, "initExitStatus");
                HandleInitExitStatus(json);
                break;
            case "proceedExitStatus":
                AckStatus(json, "proceedExitStatus");
                HandleProceedExitStatus(json);
                break;
            case "txnStatus":
                AckStatus(json, "txnStatus");
                HandleTxnStatus(json);
                break;
            case "proceedEntry":
            case "proceedExit":
            case "initEntry":
            case "initExit":
            case "initCard":
            case "initTerminal":
            case "getStatus":
            case "abortTxn":
            case "finTxn":
                // ack responses - no action required
                if (message == "proceedEntry")
                {
                    string errorCode = ExtractJsonValue(json, "errorCode");
                    string paymentMode = ExtractJsonValue(json, "paymentMode");
                    if (errorCode == "0000")
                    {
                        Debug.Log($"ProceedEntry success (paymentMode={paymentMode}) -> finish txn after delay");
                        ScheduleFinishAfterDelay();
                    }
                    else if (errorCode == "3001")
                    {
                        Debug.LogWarning("ProceedEntry invalid card (3001) -> finish txn after delay");
                        ScheduleFinishAfterDelay();
                    }
                    else
                    {
                        Debug.LogWarning($"ProceedEntry error: {errorCode} (paymentMode={paymentMode})");
                    }
                }
                break;
            default:
                if (json.Contains("\"message\":\"txnResult\""))
                {
                    StopTxnTimeout();
                    HandleTxnResult(json);
                }
                break;
        }
    }

    // ===================== SEND =====================
    public void SendMessageToServer(string message, Action action = null)
    {
        if (stream == null || !client.Connected)
        {
            Debug.Log("Not connected");
            return;
        }

        try
        {
            byte[] data = Encoding.UTF8.GetBytes(message + "\n");
            stream.Write(data, 0, data.Length);

            action?.Invoke();
        }
        catch (Exception e)
        {
            Debug.LogError("Send error: " + e.Message);
        }
    }

    // ===================== INIT TERMINAL =====================
    public void InitTerminal()
    {
        if (stream == null || !client.Connected)
        {
            Debug.LogError("Not connected to reader");
            return;
        }

        string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");

        string cleanMessage =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"initTerminal\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + "\"messageTraceID\":\"INIT001\","
        + "\"body\":{"
            + $"\"plazaID\":\"{plazaID}\","
            + $"\"laneID\":\"{laneID}\","
            + $"\"operationMode\":\"{operationMode}\","
            + $"\"laneType\":\"{laneType}\""
        + "}"
        + "}";

        string signature = ComputeSha256(secretKey, cleanMessage);
        Debug.Log("Signature: " + signature);

        string initJson =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"initTerminal\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + "\"messageTraceID\":\"INIT001\","
        + "\"body\":{"
            + $"\"plazaID\":\"{plazaID}\","
            + $"\"laneID\":\"{laneID}\","
            + $"\"operationMode\":\"{operationMode}\","
            + $"\"laneType\":\"{laneType}\""
        + "},"
        + $"\"signature\":\"{signature}\""
        + "}";

        SendMessageToServer(initJson, StartHeartbeat);
        Debug.Log("initTerminal sent");
    }

    // ===================== DE-INIT TERMINAL =====================
    public void DeInitTerminal()
    {
        if (stream == null || !client.Connected)
            return;

        string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");

        string cleanMessage =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"initTerminal\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + "\"messageTraceID\":\"DEINIT001\","
        + "\"body\":{"
            + $"\"plazaID\":\"{plazaID}\","
            + $"\"laneID\":\"{laneID}\","
            + "\"operationMode\":\"2\","
            + $"\"laneType\":\"{laneType}\""
        + "}"
        + "}";

        string signature = ComputeSha256(secretKey, cleanMessage);

        string deinitJson =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"initTerminal\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + "\"messageTraceID\":\"DEINIT001\","
        + "\"body\":{"
            + $"\"plazaID\":\"{plazaID}\","
            + $"\"laneID\":\"{laneID}\","
            + "\"operationMode\":\"2\","
            + $"\"laneType\":\"{laneType}\""
        + "},"
        + $"\"signature\":\"{signature}\""
        + "}";

        SendMessageToServer(deinitJson, StopHeartbeat);
        Debug.Log("Terminal set to NOT IN USE");
    }

    // ===================== DISCONNECT =====================
    public void Disconnect()
    {
        Debug.Log("Disconnecting TCP...");

        StopHeartbeat();
        StopTxnTimeout();
        StopInitTimeout();
        StopFinishDelay();

        isRunning = false;

        try
        {
            stream?.Close();
            client?.Close();
        }
        catch { }

        stream = null;
        client = null;

        if (receiveThread != null && receiveThread.IsAlive)
        {
            receiveThread.Join(500);
            receiveThread = null;
        }

        Debug.Log("TCP connection released");
    }

    void OnApplicationQuit()
    {
        Disconnect();
    }

    private Thread heartbeatThread;
    [SerializeField] private volatile bool heartbeatRunning = false;

    // ===================== Heartbeat Start =====================
    private void StartHeartbeat()
    {
        if (heartbeatRunning) return;

        heartbeatRunning = true;
        heartbeatThread = new Thread(() =>
        {
            while (heartbeatRunning && client != null && client.Connected)
            {
                // Debug.Log("Sending heartbeat...");
                try
                {
                    byte[] heartbeat = new byte[] { 0x00, 0x00 };
                    stream.Write(heartbeat, 0, heartbeat.Length);
                }
                catch (Exception e)
                {
                    // Debug.Log("Heartbeat stopped: " + e.Message);
                    break;
                }

                Thread.Sleep(25000); // 25s < 30s
            }
        });

        heartbeatThread.IsBackground = true;
        heartbeatThread.Start();
    }

    // ===================== Heartbeat Stop =====================
    private void StopHeartbeat()
    {
        heartbeatRunning = false;

        if (heartbeatThread != null && heartbeatThread.IsAlive)
        {
            Debug.Log("Stop");
            heartbeatThread.Join(500);
            heartbeatThread = null;
        }
    }

    // ===================== Get Status =====================
    public void GetStatus()
    {
        if (stream == null || !client.Connected)
            return;

        string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");

        string cleanMessage =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"getStatus\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + "\"messageTraceID\":\"GETSTATUS001\","
        + "\"body\":{}"
        + "}";

        string signature = ComputeSha256(secretKey, cleanMessage);

        string deinitJson =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"getStatus\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + "\"messageTraceID\":\"GETSTATUS001\","
        + "\"body\":{},"
        + $"\"signature\":\"{signature}\""
        + "}";

        SendMessageToServer(deinitJson);
        Debug.Log("Status request sent");
    }

    [Header("Parking Flow")]
    public int entryMode = 1; // 0 Pre-Auth, 1 Sale Reversal, 2 Card Validate
    public int exitMode = 1;  // Must match entryMode per spec
    public int fareAmount = 100; // 100 = RM1.00
    public string fareClass = "1";
    public int fallTimeout = 0; // Proceed Exit fallback timeout seconds
    public int payFlag = -1; // -1 = omit, 0 = TNG Purse, 1 = TNG E-Wallet

    [SerializeField] private string lastEntryDt = "";
    [SerializeField] private FlowState flowState = FlowState.Idle;


    [ContextMenu("Init Card")]
    public void InitCard()
    {
        if (stream == null || !client.Connected)
        {
            Debug.LogError("Not connected");
            return;
        }

        if (flowState != FlowState.Idle)
        {
            Debug.Log("Transaction already in progress");
            return;
        }

        string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");

        string cleanMessage =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"initCard\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + "\"messageTraceID\":\"ENTRY001\","
        + "\"body\":{"
            + $"\"fareClass\":\"FARE001\","
            + $"\"retrigger\":\"1\","
            + $"\"fareClass\":\"Test\","
            + $"\"title\":\"Test title\","
            + $"\"message\":\"Test message\""
        + "}";

        string signature = ComputeSha256(secretKey, cleanMessage);

        string txnJson =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"initCard\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + "\"messageTraceID\":\"ENTRY001\","
        + "\"body\":{"
            + $"\"fareClass\":\"FARE001\","
            + $"\"retrigger\":\"1\","
            + $"\"fareClass\":\"{fareClass}\","
            + $"\"title\":\"Test title\","
            + $"\"message\":\"Test message\""
        + "},"
        + $"\"signature\":\"{signature}\""
        + "}";

        Debug.Log("Txn : " + txnJson);

        SendMessageToServer(txnJson, StartTxnTimeout);
        flowState = FlowState.WaitingInitEntryStatus;

        Debug.Log("Transaction started. Waiting for card...");
    }

    [ContextMenu("Start Entry Flow")]
    public void StartEntryFlow()
    {
        if (stream == null || !client.Connected)
        {
            Debug.LogError("Not connected");
            return;
        }

        if (flowState != FlowState.Idle)
        {
            Debug.Log("Flow already in progress");
            return;
        }

        SendInitEntry();
    }

    private Thread txnTimeoutThread;
    [SerializeField] private volatile bool txnTimeoutActive = false;
    private const int TXN_TIMEOUT_SECONDS = 30;
    private Thread initTimeoutThread;
    [SerializeField] private volatile bool initTimeoutActive = false;
    private const int INIT_TIMEOUT_SECONDS = 120;
    private Thread finishDelayThread;
    [SerializeField] private volatile bool finishDelayActive = false;
    private const int FINISH_DELAY_SECONDS = 5;

    private void StartTxnTimeout()
    {
        txnTimeoutActive = true;

        txnTimeoutThread = new Thread(() =>
        {
            int elapsed = 0;

            while (txnTimeoutActive && elapsed < TXN_TIMEOUT_SECONDS)
            {
                Thread.Sleep(1000);
                elapsed++;
            }

            if (!txnTimeoutActive)
                return;

            Debug.Log("Transaction timeout reached (controller)");

            AbortTransaction();
            flowState = FlowState.Idle;
        });

        txnTimeoutThread.IsBackground = true;
        txnTimeoutThread.Start();
    }

    public void AbortTransaction()
    {
        if (stream == null || !client.Connected)
            return;

        string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");

        string cleanMessage =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"abortTxn\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + "\"messageTraceID\":\"ABORT001\","
        + "\"body\":{}"
        + "}";

        string signature = ComputeSha256(secretKey, cleanMessage);

        string abortJson =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"abortTxn\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + "\"messageTraceID\":\"ABORT001\","
        + "\"body\":{},"
        + $"\"signature\":\"{signature}\""
        + "}";

        SendMessageToServer(abortJson, StopTxnTimeout);
        Debug.Log("AbortTxn sent");
    }

    private void StopTxnTimeout()
    {
        txnTimeoutActive = false;

        if (txnTimeoutThread != null && txnTimeoutThread.IsAlive)
        {
            txnTimeoutThread.Join(200);
            txnTimeoutThread = null;
        }
    }

    private void StartInitTimeout()
    {
        StopInitTimeout();
        initTimeoutActive = true;

        initTimeoutThread = new Thread(() =>
        {
            int elapsed = 0;

            while (initTimeoutActive && elapsed < INIT_TIMEOUT_SECONDS)
            {
                Thread.Sleep(1000);
                elapsed++;
            }

            if (!initTimeoutActive)
                return;

            Debug.Log("InitEntry/InitExit timeout reached (controller)");
            AbortTransaction();
            flowState = FlowState.Idle;
        });

        initTimeoutThread.IsBackground = true;
        initTimeoutThread.Start();
    }

    private void StopInitTimeout()
    {
        initTimeoutActive = false;

        if (initTimeoutThread != null && initTimeoutThread.IsAlive)
        {
            initTimeoutThread.Join(200);
            initTimeoutThread = null;
        }
    }

    private void ScheduleFinishAfterDelay()
    {
        finishDelayActive = false;
        if (finishDelayThread != null && finishDelayThread.IsAlive)
        {
            finishDelayThread.Join(100);
            finishDelayThread = null;
        }

        finishDelayActive = true;
        finishDelayThread = new Thread(() =>
        {
            int elapsed = 0;
            while (finishDelayActive && elapsed < FINISH_DELAY_SECONDS)
            {
                Thread.Sleep(1000);
                elapsed++;
            }

            if (!finishDelayActive)
                return;

            FinishTransaction();
            flowState = FlowState.Idle;
        });

        finishDelayThread.IsBackground = true;
        finishDelayThread.Start();
    }

    private void StopFinishDelay()
    {
        finishDelayActive = false;

        if (finishDelayThread != null && finishDelayThread.IsAlive)
        {
            finishDelayThread.Join(200);
            finishDelayThread = null;
        }
    }

    private void HandleTxnResult(string json)
    {
        if (json.Contains("\"APPROVED\""))
        {
            Debug.Log("Payment SUCCESS -> finish txn after delay");
            ScheduleFinishAfterDelay();
        }
        else if (json.Contains("\"DECLINED\""))
        {
            Debug.Log("Payment FAILED");
        }
        else if (json.Contains("\"TIMEOUT\""))
        {
            Debug.Log("Payment TIMEOUT");
        }
        else if (json.Contains("\"CANCELLED\""))
        {
            Debug.Log("Payment CANCELLED");
        }
        else
        {
            Debug.Log("Unknown txn result");
        }

        // Always return to idle after result
        flowState = FlowState.Idle;
    }

    public void FinishTransaction()
    {
        if (stream == null || !client.Connected)
            return;

        string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");

        string cleanMessage =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"finTxn\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + "\"messageTraceID\":\"FINISH001\","
        + "\"body\":{}"
        + "}";

        string signature = ComputeSha256(secretKey, cleanMessage);

        string finishJson =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"finTxn\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + "\"messageTraceID\":\"FINISH001\","
        + "\"body\":{},"
        + $"\"signature\":\"{signature}\""
        + "}";

        SendMessageToServer(finishJson, () => { flowState = FlowState.Idle; });
        Debug.Log("FinishTxn sent");
    }

    public enum FlowState
    {
        Idle,
        WaitingInitEntryStatus,
        WaitingInitExitStatus,
        WaitingProceedExitStatus
    }

    private void SendInitEntry()
    {
        Debug.Log("Here...");
        string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
        string traceId = $"ENTRY{DateTime.Now:yyyyMMddHHmmss}";

        string cleanMessage =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"initEntry\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + $"\"messageTraceID\":\"{traceId}\","
        + "\"body\":{"
            + $"\"mode\":\"{entryMode}\","
            + $"\"fareAmount\":\"{fareAmount}\","
            + $"\"fareClass\":\"{fareClass}\","
            + $"\"title\":\"Entry <T>\","
            + $"\"message\":\"Please Tap Card\""
        + "}"
        + "}";

        string signature = ComputeSha256(secretKey, cleanMessage);

        string txnJson =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"initEntry\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + $"\"messageTraceID\":\"{traceId}\","
        + "\"body\":{"
            + $"\"mode\":\"{entryMode}\","
            + $"\"fareAmount\":\"{fareAmount}\","
            + $"\"fareClass\":\"{fareClass}\","
            + $"\"title\":\"Entry <T>\","
            + $"\"message\":\"Please Tap Card\""
        + "},"
        + $"\"signature\":\"{signature}\""
        + "}";

        Debug.Log("Init Entry Json : " + txnJson);
        SendMessageToServer(txnJson);
        StartInitTimeout();
        flowState = FlowState.WaitingInitEntryStatus;
        Debug.Log("InitEntry sent. Waiting for card...");
    }

    private void SendProceedEntry()
    {
        string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
        string traceId = $"PENTRY{DateTime.Now:yyyyMMddHHmmss}";
        string body = payFlag >= 0 ? $"\"payFlag\":\"{payFlag}\"" : "";

        string cleanMessage =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"proceedEntry\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + $"\"messageTraceID\":\"{traceId}\","
        + "\"body\":{"
            + body
        + "}"
        + "}";

        string signature = ComputeSha256(secretKey, cleanMessage);

        string txnJson =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"proceedEntry\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + $"\"messageTraceID\":\"{traceId}\","
        + "\"body\":{"
            + body
        + "},"
        + $"\"signature\":\"{signature}\""
        + "}";

        SendMessageToServer(txnJson, StartTxnTimeout);
        Debug.Log("ProceedEntry sent.");
    }

    [ContextMenu("Start Exit Flow")]
    public void StartExitFlow()
    {
        if (stream == null || !client.Connected)
        {
            Debug.LogError("Not connected");
            return;
        }

        if (flowState != FlowState.Idle)
        {
            Debug.Log("Flow already in progress");
            return;
        }

        SendInitExit();
    }

    private void SendInitExit()
    {
        string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
        string traceId = $"EXIT{DateTime.Now:yyyyMMddHHmmss}";

        string cleanMessage =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"initExit\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + $"\"messageTraceID\":\"{traceId}\","
        + "\"body\":{"
            + $"\"mode\":\"{exitMode}\""
        + "}"
        + "}";

        string signature = ComputeSha256(secretKey, cleanMessage);

        string txnJson =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"initExit\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + $"\"messageTraceID\":\"{traceId}\","
        + "\"body\":{"
            + $"\"mode\":\"{exitMode}\""
        + "},"
        + $"\"signature\":\"{signature}\""
        + "}";

        SendMessageToServer(txnJson);
        StartInitTimeout();
        flowState = FlowState.WaitingInitExitStatus;
        Debug.Log("InitExit sent. Waiting for card...");
    }

    private void SendProceedExit()
    {
        if (string.IsNullOrEmpty(lastEntryDt))
        {
            Debug.LogWarning("Missing entryDt from InitExitStatus; proceedExit may be rejected.");
        }

        string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
        string traceId = $"PEXIT{DateTime.Now:yyyyMMddHHmmss}";

        string body =
            $"\"fareAmount\":\"{fareAmount}\"," +
            $"\"fareClass\":\"{fareClass}\"," +
            $"\"fallTimeout\":\"{fallTimeout}\"" +
            (string.IsNullOrEmpty(lastEntryDt) ? "" : $",\"entryDt\":\"{lastEntryDt}\"") +
            (payFlag >= 0 ? $",\"payFlag\":\"{payFlag}\"" : "");

        string cleanMessage =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"proceedExit\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + $"\"messageTraceID\":\"{traceId}\","
        + "\"body\":{"
            + body
        + "}"
        + "}";

        string signature = ComputeSha256(secretKey, cleanMessage);

        string txnJson =
        "{"
        + "\"apiVersion\":\"1.0\","
        + "\"message\":\"proceedExit\","
        + "\"type\":\"request\","
        + $"\"timestamp\":\"{timestamp}\","
        + $"\"messageTraceID\":\"{traceId}\","
        + "\"body\":{"
            + body
        + "},"
        + $"\"signature\":\"{signature}\""
        + "}";

        SendMessageToServer(txnJson, StartTxnTimeout);
        flowState = FlowState.WaitingProceedExitStatus;
        Debug.Log("ProceedExit sent.");
    }

    private void HandleInitEntryStatus(string json)
    {
        StopInitTimeout();
        string errorCode = ExtractJsonValue(json, "errorCode");
        if (errorCode != "0000")
        {
            if (errorCode == "3001")
            {
                Debug.LogWarning("InitEntryStatus invalid card (3001) -> finish txn after delay");
                ScheduleFinishAfterDelay();
            }
            Debug.LogWarning($"InitEntryStatus error: {errorCode}");
            flowState = FlowState.Idle;
            return;
        }

        string status = ExtractJsonValue(json, "status");
        if (status == "01")
        {
            Debug.LogWarning("InitEntryStatus: entry already found for this card. Not proceeding.");
            flowState = FlowState.Idle;
            return;
        }

        SendProceedEntry();
    }

    private void HandleInitExitStatus(string json)
    {
        StopInitTimeout();
        string errorCode = ExtractJsonValue(json, "errorCode");
        if (errorCode != "0000")
        {
            if (errorCode == "3001")
            {
                Debug.LogWarning("InitExitStatus invalid card (3001) -> finish txn after delay");
                ScheduleFinishAfterDelay();
            }
            Debug.LogWarning($"InitExitStatus error: {errorCode}");
            flowState = FlowState.Idle;
            return;
        }

        lastEntryDt = ExtractJsonValue(json, "entryDt");
        SendProceedExit();
    }

    private void HandleProceedExitStatus(string json)
    {
        string errorCode = ExtractJsonValue(json, "errorCode");
        string paymentMode = ExtractJsonValue(json, "paymentMode");
        if (errorCode == "0000")
        {
            Debug.Log($"Exit payment success (paymentMode={paymentMode}) -> finish txn after delay");
            ScheduleFinishAfterDelay();
        }
        else if (errorCode == "3001")
        {
            Debug.LogWarning("ProceedExitStatus invalid card (3001) -> finish txn after delay");
            ScheduleFinishAfterDelay();
        }
        else
        {
            Debug.LogWarning($"ProceedExitStatus error: {errorCode} (paymentMode={paymentMode})");
        }

        flowState = FlowState.Idle;
        StopTxnTimeout();
    }

    private void HandleTxnStatus(string json)
    {
        string errorCode = ExtractJsonValue(json, "errorCode");
        string paymentMode = ExtractJsonValue(json, "paymentMode");
        if (errorCode == "0000")
        {
            Debug.Log($"Transaction success (paymentMode={paymentMode}) -> finish txn after delay");
            ScheduleFinishAfterDelay();
        }
        else if (errorCode == "3001")
        {
            Debug.LogWarning("TxnStatus invalid card (3001) -> finish txn after delay");
            ScheduleFinishAfterDelay();
        }
        else
        {
            Debug.LogWarning($"TxnStatus error: {errorCode} (paymentMode={paymentMode})");
        }

        flowState = FlowState.Idle;
        StopTxnTimeout();
    }

    private void AckStatus(string json, string message)
    {
        string traceId = ExtractJsonValue(json, "messageTraceID");
        if (string.IsNullOrEmpty(traceId))
            return;

        string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");

        string cleanMessage =
        "{"
        + "\"apiVersion\":\"1.0\","
        + $"\"message\":\"{message}\","
        + "\"type\":\"ack\","
        + $"\"timestamp\":\"{timestamp}\","
        + $"\"messageTraceID\":\"{traceId}\","
        + "\"body\":{"
            + "\"errorCode\":\"0000\""
        + "}"
        + "}";

        string signature = ComputeSha256(secretKey, cleanMessage);

        string ackJson =
        "{"
        + "\"apiVersion\":\"1.0\","
        + $"\"message\":\"{message}\","
        + "\"type\":\"ack\","
        + $"\"timestamp\":\"{timestamp}\","
        + $"\"messageTraceID\":\"{traceId}\","
        + "\"body\":{"
            + "\"errorCode\":\"0000\""
        + "},"
        + $"\"signature\":\"{signature}\""
        + "}";

        SendMessageToServer(ackJson);
    }

    private static string ExtractJsonValue(string json, string key)
    {
        try
        {
            string pattern = $"\\\"{key}\\\"\\s*:\\s*\\\"([^\\\"]*)\\\"";
            var match = System.Text.RegularExpressions.Regex.Match(json, pattern);
            if (match.Success && match.Groups.Count > 1)
                return match.Groups[1].Value;
        }
        catch { }

        return "";
    }
}
