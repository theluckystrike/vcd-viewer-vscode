// PWM generator with a sweep of duty cycles. Run: iverilog -o pwm hdl/pwm_tb.v && vvp pwm
`timescale 1us/1ns
module pwm (input clk, input rst, input [7:0] duty, output reg out, output reg [7:0] cnt);
  always @(posedge clk)
    if (rst) begin cnt <= 0; out <= 0; end
    else begin cnt <= cnt + 1; out <= cnt < duty; end
endmodule

module pwm_tb;
  reg clk = 0, rst = 1;
  reg [7:0] duty = 8'd32;
  wire out; wire [7:0] cnt;
  reg [8*8-1:0] phase_name = "RESET";
  pwm u_pwm(clk, rst, duty, out, cnt);
  always #0.5 clk = ~clk;
  initial begin
    $dumpfile("samples/iverilog_pwm.vcd");
    $dumpvars(0, pwm_tb);
    #3 rst = 0; phase_name = "LOW";
    #600 duty = 8'd128; phase_name = "HALF";
    #600 duty = 8'd224; phase_name = "HIGH";
    #600 $finish;
  end
endmodule
