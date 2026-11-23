(* Kernel side of the WebSocket bridge: decodes a WXF request, refuses anything outside the
   allowlist, evaluates it under time and memory limits and returns an Association.
   Loaded with -initfile; limits can be overridden by a later init file. *)

BeginPackage["WSBridge`"];

EvaluateRequest::usage = "EvaluateRequest[bytes] evaluates the WXF-encoded expression in the ByteArray bytes. A String is parsed as Wolfram Language input first.";
WSBridge`$TimeLimit::usage = "Seconds allowed per evaluation.";
WSBridge`$MemoryLimit::usage = "Bytes allowed per evaluation.";
WSBridge`$OutputLimit::usage = "Maximum length of the InputForm text of a result.";
WSBridge`$Allowed::usage = "Association of allowed System` symbol names.";
Serve::usage = "Serve[endpoint] connects a ZMQ PAIR socket to endpoint, sends \"ready\" and then answers every request message with the WXF of EvaluateRequest[message], forever.";

Begin["`Private`"];

$dir = DirectoryName[$InputFileName];
WSBridge`$TimeLimit = 30;
WSBridge`$MemoryLimit = 2*1024^3;
WSBridge`$OutputLimit = 100000;
WSBridge`$Allowed = AssociationMap[True &,
  Select[
    StringSplit[StringReplace[ReadString[FileNameJoin[{$dir, "allowlist.txt"}]], "#" ~~ Except["\n"] ... -> ""]],
    StringQ]];

failure[type_String, message_String, extra_ : <||>] :=
  Join[<|"Success" -> False, "Failure" -> type, "Message" -> message|>, extra];

(* fully qualified names of all symbols in a held expression that are not allowed *)
refused[held_HoldComplete] := Union @ Cases[held,
  s_Symbol :> With[{ctx = Context[Unevaluated[s]], name = SymbolName[Unevaluated[s]]},
    Which[
      ctx === "System`" && KeyExistsQ[WSBridge`$Allowed, name], Nothing,
      ctx === "Global`" && OwnValues[s] === {} && DownValues[s] === {} && UpValues[s] === {} &&
        SubValues[s] === {}, Nothing,
      True, ctx <> name]],
  {0, Infinity}, Heads -> True];

(* a String request is Wolfram Language input: parse it without evaluating anything *)
parse[HoldComplete[s_String]] := Which[
  StringContainsQ[s, "\\!"], failure["Syntax", "Box input (\\!) is not accepted."],
  True, Block[{$Context = "Global`", $ContextPath = {"System`", "Global`"}},
    Replace[Quiet @ ToExpression[s, InputForm, HoldComplete], {
      h_HoldComplete :> h,
      _ :> failure["Syntax", "The input could not be parsed."]}]]];
parse[held_HoldComplete] := held;

(* one line per message, arguments in InputForm: "Power::infy: Infinite expression 1/0 encountered." *)
argText[HoldCompleteForm[e_]] := ToString[Unevaluated[e], InputForm];
argText[e_] := ToString[e, InputForm];
messageText[Hold[Message[MessageName[s_Symbol, tag_String], args___]]] := Quiet @ Module[
  {name = SymbolName[Unevaluated[s]] <> "::" <> tag, template = MessageName[s, tag], texts = argText /@ {args}},
  If[!StringQ[template], template = MessageName[General, tag]];
  name <> ": " <> If[StringQ[template], ToString[StringForm[template, Sequence @@ texts]], StringRiffle[texts, " "]]];
messageText[other_] := ToString[other, InputForm];

run[held_HoldComplete] := Module[{data, result, text},
  (* a fresh $MessageList per request: the kernel lives on between requests, and a message
     already seen three times would otherwise stay suppressed by General::stop *)
  data = With[{h = held}, Block[{$MessageList = {}}, EvaluationData[
    TimeConstrained[MemoryConstrained[ReleaseHold[h], WSBridge`$MemoryLimit, $memoryExceeded], WSBridge`$TimeLimit, $timeExceeded]]]];
  result = data["Result"];
  Which[
    result === $timeExceeded, failure["TimeLimit", "The evaluation took longer than " <> ToString[WSBridge`$TimeLimit] <> " s."],
    result === $memoryExceeded, failure["MemoryLimit", "The evaluation needed more than " <> ToString[WSBridge`$MemoryLimit] <> " bytes."],
    True,
    text = ToString[result, InputForm];
    If[StringLength[text] > WSBridge`$OutputLimit, text = StringTake[text, WSBridge`$OutputLimit] <> " (...)"];
    <|"Success" -> True, "Result" -> result, "InputForm" -> text,
      "Messages" -> (messageText /@ data["MessagesExpressions"]), "Timing" -> data["AbsoluteTiming"]|>]];

EvaluateRequest[bytes_ByteArray] := Module[{held, bad},
  held = Quiet @ Check[BinaryDeserialize[bytes, HoldComplete], $Failed];
  If[!MatchQ[held, _HoldComplete], Return[failure["Decode", "The request is not valid WXF."]]];
  held = parse[held];
  If[AssociationQ[held], Return[held]];
  bad = refused[held];
  If[bad =!= {}, Return[failure["NotAllowed", "The request uses symbols that are not allowed.", <|"Symbols" -> bad|>]]];
  run[held]];
EvaluateRequest[_] := failure["Decode", "The request must be a ByteArray."];

(* The request loop. Every step runs under CheckAbort: an abort that arrives late, after a
   TimeConstrained has already returned, must not end the loop. *)
Serve[endpoint_String] := Module[{socket, request, reply},
  socket = SocketConnect[endpoint, "ZMQ_Pair"];
  If[FailureQ[socket], Print["cannot connect to ", endpoint]; Exit[3]];
  SocketWriteMessage[socket, StringToByteArray["ready"]];
  While[True,
    request = CheckAbort[SocketReadMessage[socket], $Aborted];
    If[!ByteArrayQ[request], Continue[]];
    reply = CheckAbort[EvaluateRequest[request], failure["Aborted", "The evaluation was aborted."]];
    reply = CheckAbort[BinarySerialize[reply],
      BinarySerialize[failure["Aborted", "The reply could not be serialized."]]];
    AbortProtect[SocketWriteMessage[socket, reply]]]];

End[];
EndPackage[];
