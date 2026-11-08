// Small synchronous FIFO and testbench. Run: iverilog -o fifo hdl/fifo_tb.v && vvp fifo
`timescale 1ns/1ps
module fifo #(parameter W = 8, parameter D = 4) (
  input clk, input rst_n, input push, input pop, input [W-1:0] din,
  output [W-1:0] dout, output full, output empty, output reg [D:0] count);
  reg [W-1:0] mem [0:(1<<D)-1];
  reg [D-1:0] wp, rp;
  assign dout = empty ? {W{1'bz}} : mem[rp];
  assign full = count == (1<<D);
  assign empty = count == 0;
  always @(posedge clk or negedge rst_n)
    if (!rst_n) begin wp <= 0; rp <= 0; count <= 0; end
    else begin
      if (push && !full) begin mem[wp] <= din; wp <= wp + 1; end
      if (pop && !empty) rp <= rp + 1;
      count <= count + (push && !full) - (pop && !empty);
    end
endmodule

module fifo_tb;
  reg clk = 0, rst_n = 0, push = 0, pop = 0;
  reg [7:0] din = 8'hxx;
  wire [7:0] dout; wire full, empty; wire [4:0] count;
  real fill_ratio = 0.0;
  integer i;
  fifo #(8, 4) dut(clk, rst_n, push, pop, din, dout, full, empty, count);
  always #5 clk = ~clk;
  always @(count) fill_ratio = count / 16.0;
  initial begin
    $dumpfile("samples/iverilog_fifo.vcd");
    $dumpvars(0, fifo_tb);
    #12 rst_n = 1;
    for (i = 0; i < 20; i = i + 1) begin @(negedge clk); push = 1; din = i * 13 + 7; end
    @(negedge clk); push = 0; din = 8'hxx;
    for (i = 0; i < 10; i = i + 1) begin @(negedge clk); pop = 1; end
    @(negedge clk); pop = 0;
    #40 $finish;
  end
endmodule
